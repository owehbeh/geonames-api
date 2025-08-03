const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');

const app = express();
const port = process.env.API_PORT || 3000;

app.use(helmet());
app.use(compression());
app.use(cors());
app.use(express.json({ limit: '1mb' }));

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

const validApiKeys = (process.env.API_KEYS || 'demo-key-12345').split(',');

const authenticateApiKey = (req, res, next) => {
  const apiKey = req.headers['x-api-key'] || req.query.api_key;
  
  if (!apiKey || !validApiKeys.includes(apiKey)) {
    return res.status(401).json({ 
      error: 'Invalid or missing API key. Include X-API-Key header or api_key parameter.' 
    });
  }
  
  next();
};

app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy', 
    timestamp: new Date().toISOString(),
    version: '1.0.0'
  });
});

app.get('/search', authenticateApiKey, async (req, res) => {
  try {
    const { 
      q, 
      country, 
      type, 
      autocomplete = 'false',
      limit = autocomplete === 'true' ? 10 : 20 
    } = req.query;
    
    if (!q || q.length < 2) {
      return res.status(400).json({ 
        error: 'Query parameter "q" is required and must be at least 2 characters' 
      });
    }

    let query = `
      WITH search_results AS (
        -- Search cities
        SELECT 
          'city' as type,
          c.geonameid,
          c.name,
          c.ascii_name,
          c.country_code,
          co.name as country_name,
          c.admin1_name as admin_region,
          c.latitude,
          c.longitude,
          c.alternatenames::text,
          co.spoken_languages,
          co.name_translations as country_translations,
          -- Improved scoring: prioritize exact matches, then ILIKE, then fuzzy
          CASE
            WHEN LOWER(c.name) = LOWER($1) THEN 100
            WHEN LOWER(c.ascii_name) = LOWER($1) THEN 95
            WHEN EXISTS(SELECT 1 FROM alternate_names alt WHERE alt.geonameid = c.geonameid AND LOWER(alt.alternate_name) = LOWER($1)) THEN 90
            WHEN c.name ILIKE $2 THEN 80
            WHEN c.ascii_name ILIKE $2 THEN 75
            WHEN EXISTS(SELECT 1 FROM alternate_names alt WHERE alt.geonameid = c.geonameid AND alt.alternate_name ILIKE $2) THEN 70
            ELSE GREATEST(
              similarity(c.name, $1),
              similarity(c.ascii_name, $1),
              COALESCE(MAX(similarity(alt.alternate_name, $1)), 0)
            ) * 10
          END as score,
          -- Aggregate alternate names with language codes for translations
          COALESCE(
            json_object_agg(
              alt.isolanguage, 
              alt.alternate_name
            ) FILTER (WHERE alt.isolanguage IS NOT NULL AND alt.alternate_name IS NOT NULL),
            '{}'::json
          ) as name_translations_agg
        FROM cities c
        JOIN countries co ON c.country_code = co.country_code
        LEFT JOIN alternate_names alt ON c.geonameid = alt.geonameid
        WHERE (
          c.name ILIKE $2 OR 
          c.ascii_name ILIKE $2 OR
          c.name % $1 OR
          c.ascii_name % $1 OR
          alt.alternate_name ILIKE $2 OR
          alt.alternate_name % $1
        )
        GROUP BY c.geonameid, c.name, c.ascii_name, c.country_code, 
                 co.name, c.admin1_name, c.latitude, c.longitude, 
                 c.alternatenames, co.spoken_languages, co.name_translations
        
        UNION ALL
        
        -- Search countries
        SELECT 
          'country' as type,
          NULL as geonameid,
          co.name,
          co.name as ascii_name,
          co.country_code,
          co.name as country_name,
          NULL as admin_region,
          co.latitude,
          co.longitude,
          co.name_translations::text as alternatenames,
          co.spoken_languages,
          co.name_translations as country_translations,
          -- Improved scoring for countries too
          CASE
            WHEN LOWER(co.name) = LOWER($1) THEN 100
            WHEN co.name ILIKE $2 THEN 80
            WHEN EXISTS(SELECT 1 FROM country_alternate_names alt WHERE alt.country_code = co.country_code AND LOWER(alt.name) = LOWER($1)) THEN 90
            WHEN EXISTS(SELECT 1 FROM country_alternate_names alt WHERE alt.country_code = co.country_code AND alt.name ILIKE $2) THEN 70
            ELSE GREATEST(
              similarity(co.name, $1),
              COALESCE(MAX(similarity(alt.name, $1)), 0)
            ) * 10
          END as score,
          -- Add matching column for countries (use name_translations as it already contains multilingual data)
          co.name_translations as name_translations_agg
        FROM countries co
        LEFT JOIN country_alternate_names alt ON co.country_code = alt.country_code
        WHERE (
          co.name ILIKE $2 OR
          co.name % $1 OR
          alt.name ILIKE $2 OR
          alt.name % $1
        )
        GROUP BY co.country_code, co.name, co.latitude, co.longitude,
                 co.name_translations, co.spoken_languages
      )
      SELECT * FROM search_results
    `;
    
    const params = [q, `%${q}%`];
    
    if (country) {
      query += ` WHERE country_code = $${params.length + 1}`;
      params.push(country.toUpperCase());
    }
    
    if (type && ['city', 'country'].includes(type)) {
      const whereClause = country ? 'AND' : 'WHERE';
      query += ` ${whereClause} type = $${params.length + 1}`;
      params.push(type);
    }
    
    query += ` ORDER BY score DESC, name ASC LIMIT $${params.length + 1}`;
    params.push(parseInt(limit));

    const result = await pool.query(query, params);
    
    const formattedResults = result.rows.map(row => {
      const baseResult = {
        type: row.type,
        name: row.name,
        country_code: row.country_code,
        country_name: row.country_name,
        coordinates: [parseFloat(row.latitude), parseFloat(row.longitude)]
      };

      if (row.type === 'city') {
        baseResult.admin_region = row.admin_region;
        // Use the aggregated translations from the query
        const translations = row.name_translations_agg || {};
        // Always include the primary name as English if not already present
        if (!translations.en) {
          translations.en = row.name;
        }
        baseResult.name_translations = translations;
      } else {
        baseResult.spoken_languages = row.spoken_languages ? 
          row.spoken_languages.split(',') : [];
        baseResult.name_translations = row.country_translations || {};
      }

      return baseResult;
    });
    
    res.json({
      query: q,
      results: formattedResults,
      count: formattedResults.length,
      autocomplete: autocomplete === 'true'
    });
    
  } catch (error) {
    console.error('Search error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/reverse', authenticateApiKey, async (req, res) => {
  try {
    const { lat, lon, radius = 50 } = req.query;
    
    if (!lat || !lon) {
      return res.status(400).json({ 
        error: 'Parameters "lat" and "lon" are required' 
      });
    }

    const query = `
      SELECT 
        'city' as type,
        c.geonameid,
        c.name,
        c.country_code,
        co.name as country_name,
        c.admin1_name as admin_region,
        c.latitude,
        c.longitude,
        c.alternatenames,
        co.spoken_languages,
        ST_Distance(
          ST_Point($2, $1)::geography,
          ST_Point(c.longitude, c.latitude)::geography
        ) / 1000 as distance_km
      FROM cities c
      JOIN countries co ON c.country_code = co.country_code
      WHERE ST_DWithin(
        ST_Point($2, $1)::geography,
        ST_Point(c.longitude, c.latitude)::geography,
        $3 * 1000
      )
      ORDER BY distance_km ASC
      LIMIT 5
    `;

    const result = await pool.query(query, [lat, lon, radius]);
    
    const formattedResults = result.rows.map(row => ({
      type: row.type,
      name: row.name,
      country_code: row.country_code,
      country_name: row.country_name,
      admin_region: row.admin_region,
      coordinates: [parseFloat(row.latitude), parseFloat(row.longitude)],
      distance_km: parseFloat(row.distance_km).toFixed(2)
    }));
    
    res.json({
      coordinates: [parseFloat(lat), parseFloat(lon)],
      results: formattedResults,
      count: formattedResults.length
    });
    
  } catch (error) {
    console.error('Reverse geocoding error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.use('*', (req, res) => {
  res.status(404).json({ 
    error: 'Endpoint not found. Available endpoints: /health, /search, /reverse' 
  });
});

app.use((error, req, res, next) => {
  console.error('Unhandled error:', error);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(port, '0.0.0.0', () => {
  console.log(`GeoNames API running on port ${port}`);
  console.log(`Health check: http://localhost:${port}/health`);
});