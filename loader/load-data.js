const { Pool } = require('pg');
const fs = require('fs');
const https = require('https');
const http = require('http');
const yauzl = require('yauzl');
const csv = require('csv-parser');
const path = require('path');

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
});

const DATASET = process.env.GEONAMES_DATASET || 'cities15000';

async function createTables() {
  console.log('Creating database tables...');
  
  const createTablesSQL = `
    -- Enable PostGIS and fuzzy matching
    CREATE EXTENSION IF NOT EXISTS postgis;
    CREATE EXTENSION IF NOT EXISTS pg_trgm;
    
    -- Countries table
    CREATE TABLE IF NOT EXISTS countries (
      country_code CHAR(2) PRIMARY KEY,
      name VARCHAR(200) NOT NULL,
      latitude DECIMAL(10,8),
      longitude DECIMAL(11,8),
      spoken_languages TEXT,
      name_translations JSONB
    );
    
    -- Cities table  
    CREATE TABLE IF NOT EXISTS cities (
      geonameid INTEGER PRIMARY KEY,
      name VARCHAR(200) NOT NULL,
      ascii_name VARCHAR(200),
      alternatenames TEXT,
      latitude DECIMAL(10,8),
      longitude DECIMAL(11,8),
      feature_class CHAR(1),
      feature_code VARCHAR(10),
      country_code CHAR(2),
      admin1_code VARCHAR(20),
      admin1_name VARCHAR(200),
      population BIGINT,
      elevation INTEGER,
      timezone VARCHAR(40),
      modification_date DATE
    );
    
    -- Alternate names for multilingual support
    CREATE TABLE IF NOT EXISTS alternate_names (
      alternatenameid INTEGER PRIMARY KEY,
      geonameid INTEGER,
      isolanguage VARCHAR(7),
      alternate_name VARCHAR(400),
      is_preferred_name BOOLEAN,
      is_short_name BOOLEAN,
      is_colloquial BOOLEAN,
      is_historic BOOLEAN
    );
    
    -- Country alternate names
    CREATE TABLE IF NOT EXISTS country_alternate_names (
      id SERIAL PRIMARY KEY,
      country_code CHAR(2),
      isolanguage VARCHAR(7),
      name VARCHAR(200)
    );
    
    -- Create indexes for performance
    CREATE INDEX IF NOT EXISTS idx_cities_name ON cities USING gin(name gin_trgm_ops);
    CREATE INDEX IF NOT EXISTS idx_cities_ascii ON cities USING gin(ascii_name gin_trgm_ops);
    CREATE INDEX IF NOT EXISTS idx_cities_country ON cities(country_code);
    CREATE INDEX IF NOT EXISTS idx_cities_coords ON cities USING gist(ST_Point(longitude, latitude));
    CREATE INDEX IF NOT EXISTS idx_alt_names_geonameid ON alternate_names(geonameid);
    CREATE INDEX IF NOT EXISTS idx_alt_names_name ON alternate_names USING gin(alternate_name gin_trgm_ops);
    CREATE INDEX IF NOT EXISTS idx_countries_name ON countries USING gin(name gin_trgm_ops);
    
    -- Foreign key constraints (added after data loading)
    -- These will be added later to avoid constraint issues during loading
  `;
  
  await pool.query(createTablesSQL);
  console.log('✅ Tables created successfully');
}

async function downloadFile(url, filename) {
  return new Promise((resolve, reject) => {
    console.log(`📥 Downloading ${filename}...`);
    const file = fs.createWriteStream(filename);
    const protocol = url.startsWith('https:') ? https : http;
    
    protocol.get(url, (response) => {
      if (response.statusCode !== 200) {
        reject(new Error(`HTTP ${response.statusCode}: ${response.statusMessage}`));
        return;
      }
      
      response.pipe(file);
      file.on('finish', () => {
        file.close();
        console.log(`✅ Downloaded ${filename}`);
        resolve();
      });
    }).on('error', reject);
  });
}

async function extractZip(zipPath, extractPath) {
  return new Promise((resolve, reject) => {
    console.log(`📦 Extracting ${zipPath}...`);
    yauzl.open(zipPath, { lazyEntries: true }, (err, zipfile) => {
      if (err) reject(err);
      
      zipfile.readEntry();
      zipfile.on('entry', (entry) => {
        if (/\/$/.test(entry.fileName)) {
          zipfile.readEntry();
        } else {
          zipfile.openReadStream(entry, (err, readStream) => {
            if (err) reject(err);
            
            const outputPath = path.join(extractPath, entry.fileName);
            const writeStream = fs.createWriteStream(outputPath);
            readStream.pipe(writeStream);
            writeStream.on('close', () => {
              console.log(`✅ Extracted ${entry.fileName}`);
              zipfile.readEntry();
            });
          });
        }
      });
      
      zipfile.on('end', resolve);
      zipfile.on('error', reject);
    });
  });
}

async function loadCountriesData() {
  console.log('🌍 Loading countries data...');
  
  const countries = [
    { code: 'US', name: 'United States', lat: 39.8283, lng: -98.5795, 
      languages: 'en', translations: '{"en":"United States","es":"Estados Unidos","fr":"États-Unis","de":"Vereinigte Staaten"}' },
    { code: 'GB', name: 'United Kingdom', lat: 54.7023, lng: -3.2765, 
      languages: 'en,cy,gd', translations: '{"en":"United Kingdom","es":"Reino Unido","fr":"Royaume-Uni","de":"Vereinigtes Königreich"}' },
    { code: 'FR', name: 'France', lat: 46.2276, lng: 2.2137, 
      languages: 'fr', translations: '{"en":"France","es":"Francia","fr":"France","de":"Frankreich"}' },
    { code: 'DE', name: 'Germany', lat: 51.1657, lng: 10.4515, 
      languages: 'de', translations: '{"en":"Germany","es":"Alemania","fr":"Allemagne","de":"Deutschland"}' },
    { code: 'JP', name: 'Japan', lat: 36.2048, lng: 138.2529, 
      languages: 'ja', translations: '{"en":"Japan","es":"Japón","fr":"Japon","de":"Japan","ja":"日本"}' }
  ];
  
  for (const country of countries) {
    await pool.query(`
      INSERT INTO countries (country_code, name, latitude, longitude, spoken_languages, name_translations)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (country_code) DO UPDATE SET
        name = EXCLUDED.name,
        latitude = EXCLUDED.latitude,
        longitude = EXCLUDED.longitude,
        spoken_languages = EXCLUDED.spoken_languages,
        name_translations = EXCLUDED.name_translations
    `, [country.code, country.name, country.lat, country.lng, country.languages, country.translations]);
  }
  
  console.log(`✅ Loaded ${countries.length} countries`);
}

async function loadCitiesData() {
  console.log('🏙️ Loading cities data...');
  
  const existingCount = await pool.query('SELECT COUNT(*) FROM cities');
  if (parseInt(existingCount.rows[0].count) > 0) {
    console.log('ℹ️ Cities data already exists, skipping import');
    return;
  }
  
  const dataDir = '/app/data';
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
  
  const zipFile = path.join(dataDir, `${DATASET}.zip`);
  const txtFile = path.join(dataDir, `${DATASET}.txt`);
  
  if (!fs.existsSync(txtFile)) {
    const downloadUrl = `http://download.geonames.org/export/dump/${DATASET}.zip`;
    await downloadFile(downloadUrl, zipFile);
    await extractZip(zipFile, dataDir);
  }
  
  console.log('📊 Importing cities data...');
  let count = 0;
  
  return new Promise((resolve, reject) => {
    fs.createReadStream(txtFile)
      .pipe(csv({
        separator: '\t',
        headers: [
          'geonameid', 'name', 'asciiname', 'alternatenames',
          'latitude', 'longitude', 'feature_class', 'feature_code',
          'country_code', 'cc2', 'admin1_code', 'admin2_code',
          'admin3_code', 'admin4_code', 'population', 'elevation',
          'dem', 'timezone', 'modification_date'
        ]
      }))
      .on('data', async (row) => {
        try {
          await pool.query(`
            INSERT INTO cities (
              geonameid, name, ascii_name, alternatenames, latitude, longitude,
              feature_class, feature_code, country_code, admin1_code, admin1_name,
              population, elevation, timezone, modification_date
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
            ON CONFLICT (geonameid) DO NOTHING
          `, [
            parseInt(row.geonameid), row.name, row.asciiname, row.alternatenames,
            parseFloat(row.latitude), parseFloat(row.longitude),
            row.feature_class, row.feature_code, row.country_code, row.admin1_code, null,
            row.population ? parseInt(row.population) : null,
            row.elevation ? parseInt(row.elevation) : null,
            row.timezone, row.modification_date || null
          ]);
          
          count++;
          if (count % 10000 === 0) {
            console.log(`📥 Imported ${count} cities...`);
          }
        } catch (error) {
          console.error('Error importing city:', error.message);
        }
      })
      .on('end', () => {
        console.log(`✅ Imported ${count} cities successfully`);
        resolve();
      })
      .on('error', reject);
  });
}

async function loadAlternateNames() {
  console.log('🗣️ Loading alternate names for multilingual support...');
  
  const existingCount = await pool.query('SELECT COUNT(*) FROM alternate_names');
  if (parseInt(existingCount.rows[0].count) > 0) {
    console.log('ℹ️ Alternate names already exist, skipping import');
    return;
  }
  
  const dataDir = '/app/data';
  const zipFile = path.join(dataDir, 'alternateNamesV2.zip');
  const txtFile = path.join(dataDir, 'alternateNamesV2.txt');
  
  if (!fs.existsSync(txtFile)) {
    const downloadUrl = 'http://download.geonames.org/export/dump/alternateNamesV2.zip';
    await downloadFile(downloadUrl, zipFile);
    await extractZip(zipFile, dataDir);
  }
  
  console.log('📊 Importing alternate names...');
  let count = 0;
  let processed = 0;
  
  return new Promise((resolve, reject) => {
    fs.createReadStream(txtFile)
      .pipe(csv({
        separator: '\t',
        headers: [
          'alternatenameid', 'geonameid', 'isolanguage', 'alternate_name',
          'is_preferred_name', 'is_short_name', 'is_colloquial', 'is_historic',
          'from', 'to'
        ]
      }))
      .on('data', async (row) => {
        processed++;
        
        if (row.isolanguage && row.isolanguage.length <= 7 && row.alternate_name) {
          try {
            const cityExists = await pool.query(
              'SELECT 1 FROM cities WHERE geonameid = $1', 
              [parseInt(row.geonameid)]
            );
            
            if (cityExists.rows.length > 0) {
              await pool.query(`
                INSERT INTO alternate_names (
                  alternatenameid, geonameid, isolanguage, alternate_name,
                  is_preferred_name, is_short_name, is_colloquial, is_historic
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                ON CONFLICT (alternatenameid) DO NOTHING
              `, [
                parseInt(row.alternatenameid), parseInt(row.geonameid),
                row.isolanguage, row.alternate_name,
                row.is_preferred_name === '1',
                row.is_short_name === '1',
                row.is_colloquial === '1',
                row.is_historic === '1'
              ]);
              
              count++;
            }
          } catch (error) {
            // Skip invalid rows
          }
        }
        
        if (processed % 100000 === 0) {
          console.log(`📥 Processed ${processed} alternate names, imported ${count}...`);
        }
      })
      .on('end', () => {
        console.log(`✅ Imported ${count} alternate names successfully`);
        resolve();
      })
      .on('error', reject);
  });
}

async function optimizeDatabase() {
  console.log('⚡ Optimizing database...');
  
  await pool.query('ANALYZE cities');
  await pool.query('ANALYZE countries');
  await pool.query('ANALYZE alternate_names');
  
  console.log('✅ Database optimization complete');
}

async function main() {
  try {
    console.log('🚀 Starting GeoNames data import...');
    console.log(`📦 Dataset: ${DATASET}`);
    
    await createTables();
    await loadCountriesData();
    await loadCitiesData();
    await loadAlternateNames();
    await optimizeDatabase();
    
    const cityCount = await pool.query('SELECT COUNT(*) FROM cities');
    const countryCount = await pool.query('SELECT COUNT(*) FROM countries');
    const altCount = await pool.query('SELECT COUNT(*) FROM alternate_names');
    
    console.log('\n🎉 Import completed successfully!');
    console.log(`📊 Statistics:`);
    console.log(`   • ${countryCount.rows[0].count} countries`);
    console.log(`   • ${cityCount.rows[0].count} cities`);
    console.log(`   • ${altCount.rows[0].count} alternate names`);
    console.log('\n✅ GeoNames API is ready to use!');
    
  } catch (error) {
    console.error('❌ Import failed:', error);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();