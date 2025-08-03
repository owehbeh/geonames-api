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
const SUPPORTED_LANGUAGES = process.env.SUPPORTED_LANGUAGES ? 
  process.env.SUPPORTED_LANGUAGES.split(',').map(lang => lang.trim().toLowerCase()) : 
  null; // null means load all languages

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
  
  // First, drop any existing foreign key constraints to avoid import issues
  try {
    await pool.query('ALTER TABLE cities DROP CONSTRAINT IF EXISTS fk_cities_country');
    await pool.query('ALTER TABLE alternate_names DROP CONSTRAINT IF EXISTS fk_alt_names_geonameid');
    console.log('✅ Dropped existing foreign key constraints');
  } catch (error) {
    console.log('ℹ️ No foreign key constraints to drop');
  }
  
  // Create a comprehensive list of country codes that might appear in GeoNames
  // This is a basic set - in production you'd load from countryInfo.txt
  const countries = [
    { code: 'AD', name: 'Andorra', lat: 42.5, lng: 1.5, languages: 'ca', translations: '{"en":"Andorra"}' },
    { code: 'AE', name: 'United Arab Emirates', lat: 24, lng: 54, languages: 'ar', translations: '{"en":"United Arab Emirates"}' },
    { code: 'AF', name: 'Afghanistan', lat: 33, lng: 65, languages: 'fa,ps', translations: '{"en":"Afghanistan"}' },
    { code: 'AG', name: 'Antigua and Barbuda', lat: 17.05, lng: -61.8, languages: 'en', translations: '{"en":"Antigua and Barbuda"}' },
    { code: 'AI', name: 'Anguilla', lat: 18.25, lng: -63.17, languages: 'en', translations: '{"en":"Anguilla"}' },
    { code: 'AL', name: 'Albania', lat: 41, lng: 20, languages: 'sq', translations: '{"en":"Albania"}' },
    { code: 'AM', name: 'Armenia', lat: 40, lng: 45, languages: 'hy', translations: '{"en":"Armenia"}' },
    { code: 'AO', name: 'Angola', lat: -12.5, lng: 18.5, languages: 'pt', translations: '{"en":"Angola"}' },
    { code: 'AQ', name: 'Antarctica', lat: -90, lng: 0, languages: '', translations: '{"en":"Antarctica"}' },
    { code: 'AR', name: 'Argentina', lat: -34, lng: -64, languages: 'es', translations: '{"en":"Argentina"}' },
    { code: 'AS', name: 'American Samoa', lat: -14.33, lng: -170, languages: 'en', translations: '{"en":"American Samoa"}' },
    { code: 'AT', name: 'Austria', lat: 47.33, lng: 13.33, languages: 'de', translations: '{"en":"Austria"}' },
    { code: 'AU', name: 'Australia', lat: -27, lng: 133, languages: 'en', translations: '{"en":"Australia"}' },
    { code: 'AW', name: 'Aruba', lat: 12.5, lng: -69.97, languages: 'nl', translations: '{"en":"Aruba"}' },
    { code: 'AX', name: 'Åland Islands', lat: 60.12, lng: 19.9, languages: 'sv', translations: '{"en":"Åland Islands"}' },
    { code: 'AZ', name: 'Azerbaijan', lat: 40.5, lng: 47.5, languages: 'az', translations: '{"en":"Azerbaijan"}' },
    { code: 'BA', name: 'Bosnia and Herzegovina', lat: 44, lng: 18, languages: 'bs,hr,sr', translations: '{"en":"Bosnia and Herzegovina"}' },
    { code: 'BB', name: 'Barbados', lat: 13.17, lng: -59.53, languages: 'en', translations: '{"en":"Barbados"}' },
    { code: 'BD', name: 'Bangladesh', lat: 24, lng: 90, languages: 'bn', translations: '{"en":"Bangladesh"}' },
    { code: 'BE', name: 'Belgium', lat: 50.83, lng: 4, languages: 'nl,fr,de', translations: '{"en":"Belgium"}' },
    { code: 'BF', name: 'Burkina Faso', lat: 13, lng: -2, languages: 'fr', translations: '{"en":"Burkina Faso"}' },
    { code: 'BG', name: 'Bulgaria', lat: 43, lng: 25, languages: 'bg', translations: '{"en":"Bulgaria"}' },
    { code: 'BH', name: 'Bahrain', lat: 26, lng: 50.55, languages: 'ar', translations: '{"en":"Bahrain"}' },
    { code: 'BI', name: 'Burundi', lat: -3.5, lng: 30, languages: 'rn,fr', translations: '{"en":"Burundi"}' },
    { code: 'BJ', name: 'Benin', lat: 9.5, lng: 2.25, languages: 'fr', translations: '{"en":"Benin"}' },
    { code: 'BL', name: 'Saint Barthélemy', lat: 17.9, lng: -62.83, languages: 'fr', translations: '{"en":"Saint Barthélemy"}' },
    { code: 'BM', name: 'Bermuda', lat: 32.33, lng: -64.75, languages: 'en', translations: '{"en":"Bermuda"}' },
    { code: 'BN', name: 'Brunei', lat: 4.5, lng: 114.67, languages: 'ms', translations: '{"en":"Brunei"}' },
    { code: 'BO', name: 'Bolivia', lat: -17, lng: -65, languages: 'es,qu,ay', translations: '{"en":"Bolivia"}' },
    { code: 'BQ', name: 'Bonaire', lat: 12.15, lng: -68.27, languages: 'nl', translations: '{"en":"Bonaire"}' },
    { code: 'BR', name: 'Brazil', lat: -10, lng: -55, languages: 'pt', translations: '{"en":"Brazil"}' },
    { code: 'BS', name: 'Bahamas', lat: 24.25, lng: -76, languages: 'en', translations: '{"en":"Bahamas"}' },
    { code: 'BT', name: 'Bhutan', lat: 27.5, lng: 90.5, languages: 'dz', translations: '{"en":"Bhutan"}' },
    { code: 'BV', name: 'Bouvet Island', lat: -54.43, lng: 3.4, languages: '', translations: '{"en":"Bouvet Island"}' },
    { code: 'BW', name: 'Botswana', lat: -22, lng: 24, languages: 'en,tn', translations: '{"en":"Botswana"}' },
    { code: 'BY', name: 'Belarus', lat: 53, lng: 28, languages: 'be,ru', translations: '{"en":"Belarus"}' },
    { code: 'BZ', name: 'Belize', lat: 17.25, lng: -88.75, languages: 'en', translations: '{"en":"Belize"}' },
    { code: 'CA', name: 'Canada', lat: 60, lng: -95, languages: 'en,fr', translations: '{"en":"Canada"}' },
    { code: 'CC', name: 'Cocos Islands', lat: -12.5, lng: 96.83, languages: 'en', translations: '{"en":"Cocos Islands"}' },
    { code: 'CD', name: 'Democratic Republic of the Congo', lat: 0, lng: 25, languages: 'fr', translations: '{"en":"Democratic Republic of the Congo"}' },
    { code: 'CF', name: 'Central African Republic', lat: 7, lng: 21, languages: 'fr', translations: '{"en":"Central African Republic"}' },
    { code: 'CG', name: 'Republic of the Congo', lat: -1, lng: 15, languages: 'fr', translations: '{"en":"Republic of the Congo"}' },
    { code: 'CH', name: 'Switzerland', lat: 47, lng: 8, languages: 'de,fr,it,rm', translations: '{"en":"Switzerland"}' },
    { code: 'CI', name: 'Ivory Coast', lat: 8, lng: -5, languages: 'fr', translations: '{"en":"Ivory Coast"}' },
    { code: 'CK', name: 'Cook Islands', lat: -21.23, lng: -159.77, languages: 'en', translations: '{"en":"Cook Islands"}' },
    { code: 'CL', name: 'Chile', lat: -30, lng: -71, languages: 'es', translations: '{"en":"Chile"}' },
    { code: 'CM', name: 'Cameroon', lat: 6, lng: 12, languages: 'en,fr', translations: '{"en":"Cameroon"}' },
    { code: 'CN', name: 'China', lat: 35, lng: 105, languages: 'zh', translations: '{"en":"China"}' },
    { code: 'CO', name: 'Colombia', lat: 4, lng: -72, languages: 'es', translations: '{"en":"Colombia"}' },
    { code: 'CR', name: 'Costa Rica', lat: 10, lng: -84, languages: 'es', translations: '{"en":"Costa Rica"}' },
    { code: 'CU', name: 'Cuba', lat: 21.5, lng: -80, languages: 'es', translations: '{"en":"Cuba"}' },
    { code: 'CV', name: 'Cape Verde', lat: 16, lng: -24, languages: 'pt', translations: '{"en":"Cape Verde"}' },
    { code: 'CW', name: 'Curaçao', lat: 12.17, lng: -69, languages: 'nl', translations: '{"en":"Curaçao"}' },
    { code: 'CX', name: 'Christmas Island', lat: -10.5, lng: 105.67, languages: 'en', translations: '{"en":"Christmas Island"}' },
    { code: 'CY', name: 'Cyprus', lat: 35, lng: 33, languages: 'el,tr', translations: '{"en":"Cyprus"}' },
    { code: 'CZ', name: 'Czech Republic', lat: 49.75, lng: 15.5, languages: 'cs', translations: '{"en":"Czech Republic"}' },
    { code: 'DE', name: 'Germany', lat: 51.1657, lng: 10.4515, languages: 'de', translations: '{"en":"Germany","es":"Alemania","fr":"Allemagne","de":"Deutschland"}' },
    { code: 'DJ', name: 'Djibouti', lat: 11.5, lng: 43, languages: 'fr,ar', translations: '{"en":"Djibouti"}' },
    { code: 'DK', name: 'Denmark', lat: 56, lng: 10, languages: 'da', translations: '{"en":"Denmark"}' },
    { code: 'DM', name: 'Dominica', lat: 15.42, lng: -61.33, languages: 'en', translations: '{"en":"Dominica"}' },
    { code: 'DO', name: 'Dominican Republic', lat: 19, lng: -70.67, languages: 'es', translations: '{"en":"Dominican Republic"}' },
    { code: 'DZ', name: 'Algeria', lat: 28, lng: 3, languages: 'ar', translations: '{"en":"Algeria"}' },
    { code: 'EC', name: 'Ecuador', lat: -2, lng: -77.5, languages: 'es', translations: '{"en":"Ecuador"}' },
    { code: 'EE', name: 'Estonia', lat: 59, lng: 26, languages: 'et', translations: '{"en":"Estonia"}' },
    { code: 'EG', name: 'Egypt', lat: 27, lng: 30, languages: 'ar', translations: '{"en":"Egypt"}' },
    { code: 'EH', name: 'Western Sahara', lat: 24.5, lng: -13, languages: 'ar', translations: '{"en":"Western Sahara"}' },
    { code: 'ER', name: 'Eritrea', lat: 15, lng: 39, languages: 'ti,ar', translations: '{"en":"Eritrea"}' },
    { code: 'ES', name: 'Spain', lat: 40, lng: -4, languages: 'es', translations: '{"en":"Spain"}' },
    { code: 'ET', name: 'Ethiopia', lat: 8, lng: 38, languages: 'am', translations: '{"en":"Ethiopia"}' },
    { code: 'FI', name: 'Finland', lat: 64, lng: 26, languages: 'fi,sv', translations: '{"en":"Finland"}' },
    { code: 'FJ', name: 'Fiji', lat: -18, lng: 175, languages: 'en,fj', translations: '{"en":"Fiji"}' },
    { code: 'FK', name: 'Falkland Islands', lat: -51.75, lng: -59, languages: 'en', translations: '{"en":"Falkland Islands"}' },
    { code: 'FM', name: 'Micronesia', lat: 6.92, lng: 158.25, languages: 'en', translations: '{"en":"Micronesia"}' },
    { code: 'FO', name: 'Faroe Islands', lat: 62, lng: -7, languages: 'fo', translations: '{"en":"Faroe Islands"}' },
    { code: 'FR', name: 'France', lat: 46.2276, lng: 2.2137, languages: 'fr', translations: '{"en":"France","es":"Francia","fr":"France","de":"Frankreich"}' },
    { code: 'GA', name: 'Gabon', lat: -1, lng: 11.75, languages: 'fr', translations: '{"en":"Gabon"}' },
    { code: 'GB', name: 'United Kingdom', lat: 54.7023, lng: -3.2765, languages: 'en,cy,gd', translations: '{"en":"United Kingdom","es":"Reino Unido","fr":"Royaume-Uni","de":"Vereinigtes Königreich"}' },
    { code: 'GD', name: 'Grenada', lat: 12.12, lng: -61.67, languages: 'en', translations: '{"en":"Grenada"}' },
    { code: 'GE', name: 'Georgia', lat: 42, lng: 43.5, languages: 'ka', translations: '{"en":"Georgia"}' },
    { code: 'GF', name: 'French Guiana', lat: 4, lng: -53, languages: 'fr', translations: '{"en":"French Guiana"}' },
    { code: 'GG', name: 'Guernsey', lat: 49.5, lng: -2.56, languages: 'en', translations: '{"en":"Guernsey"}' },
    { code: 'GH', name: 'Ghana', lat: 8, lng: -2, languages: 'en', translations: '{"en":"Ghana"}' },
    { code: 'GI', name: 'Gibraltar', lat: 36.18, lng: -5.37, languages: 'en', translations: '{"en":"Gibraltar"}' },
    { code: 'GL', name: 'Greenland', lat: 72, lng: -40, languages: 'kl,da', translations: '{"en":"Greenland"}' },
    { code: 'GM', name: 'Gambia', lat: 13.47, lng: -16.57, languages: 'en', translations: '{"en":"Gambia"}' },
    { code: 'GN', name: 'Guinea', lat: 11, lng: -10, languages: 'fr', translations: '{"en":"Guinea"}' },
    { code: 'GP', name: 'Guadeloupe', lat: 16.25, lng: -61.58, languages: 'fr', translations: '{"en":"Guadeloupe"}' },
    { code: 'GQ', name: 'Equatorial Guinea', lat: 2, lng: 10, languages: 'es,fr', translations: '{"en":"Equatorial Guinea"}' },
    { code: 'GR', name: 'Greece', lat: 39, lng: 22, languages: 'el', translations: '{"en":"Greece"}' },
    { code: 'GS', name: 'South Georgia', lat: -54.5, lng: -37, languages: 'en', translations: '{"en":"South Georgia"}' },
    { code: 'GT', name: 'Guatemala', lat: 15.5, lng: -90.25, languages: 'es', translations: '{"en":"Guatemala"}' },
    { code: 'GU', name: 'Guam', lat: 13.47, lng: 144.78, languages: 'en', translations: '{"en":"Guam"}' },
    { code: 'GW', name: 'Guinea-Bissau', lat: 12, lng: -15, languages: 'pt', translations: '{"en":"Guinea-Bissau"}' },
    { code: 'GY', name: 'Guyana', lat: 5, lng: -59, languages: 'en', translations: '{"en":"Guyana"}' },
    { code: 'HK', name: 'Hong Kong', lat: 22.27, lng: 114.18, languages: 'zh,en', translations: '{"en":"Hong Kong"}' },
    { code: 'HM', name: 'Heard Island', lat: -53.1, lng: 72.52, languages: '', translations: '{"en":"Heard Island"}' },
    { code: 'HN', name: 'Honduras', lat: 15, lng: -86.5, languages: 'es', translations: '{"en":"Honduras"}' },
    { code: 'HR', name: 'Croatia', lat: 45.17, lng: 15.5, languages: 'hr', translations: '{"en":"Croatia"}' },
    { code: 'HT', name: 'Haiti', lat: 19, lng: -72.42, languages: 'fr,ht', translations: '{"en":"Haiti"}' },
    { code: 'HU', name: 'Hungary', lat: 47, lng: 20, languages: 'hu', translations: '{"en":"Hungary"}' },
    { code: 'ID', name: 'Indonesia', lat: -5, lng: 120, languages: 'id', translations: '{"en":"Indonesia"}' },
    { code: 'IE', name: 'Ireland', lat: 53, lng: -8, languages: 'en,ga', translations: '{"en":"Ireland"}' },
    { code: 'IL', name: 'Israel', lat: 31.5, lng: 34.75, languages: 'he,ar', translations: '{"en":"Israel"}' },
    { code: 'IM', name: 'Isle of Man', lat: 54.23, lng: -4.55, languages: 'en', translations: '{"en":"Isle of Man"}' },
    { code: 'IN', name: 'India', lat: 20, lng: 77, languages: 'hi,en', translations: '{"en":"India"}' },
    { code: 'IO', name: 'British Indian Ocean Territory', lat: -6, lng: 71.5, languages: 'en', translations: '{"en":"British Indian Ocean Territory"}' },
    { code: 'IQ', name: 'Iraq', lat: 33, lng: 44, languages: 'ar,ku', translations: '{"en":"Iraq"}' },
    { code: 'IR', name: 'Iran', lat: 32, lng: 53, languages: 'fa', translations: '{"en":"Iran"}' },
    { code: 'IS', name: 'Iceland', lat: 65, lng: -18, languages: 'is', translations: '{"en":"Iceland"}' },
    { code: 'IT', name: 'Italy', lat: 42.83, lng: 12.83, languages: 'it', translations: '{"en":"Italy"}' },
    { code: 'JE', name: 'Jersey', lat: 49.21, lng: -2.13, languages: 'en', translations: '{"en":"Jersey"}' },
    { code: 'JM', name: 'Jamaica', lat: 18.25, lng: -77.5, languages: 'en', translations: '{"en":"Jamaica"}' },
    { code: 'JO', name: 'Jordan', lat: 31, lng: 36, languages: 'ar', translations: '{"en":"Jordan"}' },
    { code: 'JP', name: 'Japan', lat: 36.2048, lng: 138.2529, languages: 'ja', translations: '{"en":"Japan","es":"Japón","fr":"Japon","de":"Japan","ja":"日本"}' },
    { code: 'KE', name: 'Kenya', lat: 1, lng: 38, languages: 'en,sw', translations: '{"en":"Kenya"}' },
    { code: 'KG', name: 'Kyrgyzstan', lat: 41, lng: 75, languages: 'ky,ru', translations: '{"en":"Kyrgyzstan"}' },
    { code: 'KH', name: 'Cambodia', lat: 13, lng: 105, languages: 'km', translations: '{"en":"Cambodia"}' },
    { code: 'KI', name: 'Kiribati', lat: 1.42, lng: 173, languages: 'en', translations: '{"en":"Kiribati"}' },
    { code: 'KM', name: 'Comoros', lat: -12.17, lng: 44.25, languages: 'ar,fr', translations: '{"en":"Comoros"}' },
    { code: 'KN', name: 'Saint Kitts and Nevis', lat: 17.33, lng: -62.75, languages: 'en', translations: '{"en":"Saint Kitts and Nevis"}' },
    { code: 'KP', name: 'North Korea', lat: 40, lng: 127, languages: 'ko', translations: '{"en":"North Korea"}' },
    { code: 'KR', name: 'South Korea', lat: 37, lng: 127.5, languages: 'ko', translations: '{"en":"South Korea"}' },
    { code: 'KW', name: 'Kuwait', lat: 29.34, lng: 47.66, languages: 'ar', translations: '{"en":"Kuwait"}' },
    { code: 'KY', name: 'Cayman Islands', lat: 19.5, lng: -80.5, languages: 'en', translations: '{"en":"Cayman Islands"}' },
    { code: 'KZ', name: 'Kazakhstan', lat: 48, lng: 68, languages: 'kk,ru', translations: '{"en":"Kazakhstan"}' },
    { code: 'LA', name: 'Laos', lat: 18, lng: 105, languages: 'lo', translations: '{"en":"Laos"}' },
    { code: 'LB', name: 'Lebanon', lat: 33.83, lng: 35.83, languages: 'ar,fr', translations: '{"en":"Lebanon"}' },
    { code: 'LC', name: 'Saint Lucia', lat: 13.88, lng: -61.13, languages: 'en', translations: '{"en":"Saint Lucia"}' },
    { code: 'LI', name: 'Liechtenstein', lat: 47.17, lng: 9.53, languages: 'de', translations: '{"en":"Liechtenstein"}' },
    { code: 'LK', name: 'Sri Lanka', lat: 7, lng: 81, languages: 'si,ta', translations: '{"en":"Sri Lanka"}' },
    { code: 'LR', name: 'Liberia', lat: 6.5, lng: -9.5, languages: 'en', translations: '{"en":"Liberia"}' },
    { code: 'LS', name: 'Lesotho', lat: -29.5, lng: 28.5, languages: 'en,st', translations: '{"en":"Lesotho"}' },
    { code: 'LT', name: 'Lithuania', lat: 56, lng: 24, languages: 'lt', translations: '{"en":"Lithuania"}' },
    { code: 'LU', name: 'Luxembourg', lat: 49.75, lng: 6.17, languages: 'lb,fr,de', translations: '{"en":"Luxembourg"}' },
    { code: 'LV', name: 'Latvia', lat: 57, lng: 25, languages: 'lv', translations: '{"en":"Latvia"}' },
    { code: 'LY', name: 'Libya', lat: 25, lng: 17, languages: 'ar', translations: '{"en":"Libya"}' },
    { code: 'MA', name: 'Morocco', lat: 32, lng: -5, languages: 'ar', translations: '{"en":"Morocco"}' },
    { code: 'MC', name: 'Monaco', lat: 43.73, lng: 7.4, languages: 'fr', translations: '{"en":"Monaco"}' },
    { code: 'MD', name: 'Moldova', lat: 47, lng: 29, languages: 'ro', translations: '{"en":"Moldova"}' },
    { code: 'ME', name: 'Montenegro', lat: 42, lng: 19, languages: 'sr', translations: '{"en":"Montenegro"}' },
    { code: 'MF', name: 'Saint Martin', lat: 18.08, lng: -63.95, languages: 'fr', translations: '{"en":"Saint Martin"}' },
    { code: 'MG', name: 'Madagascar', lat: -20, lng: 47, languages: 'fr,mg', translations: '{"en":"Madagascar"}' },
    { code: 'MH', name: 'Marshall Islands', lat: 9, lng: 168, languages: 'en', translations: '{"en":"Marshall Islands"}' },
    { code: 'MK', name: 'North Macedonia', lat: 41.83, lng: 22, languages: 'mk', translations: '{"en":"North Macedonia"}' },
    { code: 'ML', name: 'Mali', lat: 17, lng: -4, languages: 'fr', translations: '{"en":"Mali"}' },
    { code: 'MM', name: 'Myanmar', lat: 22, lng: 98, languages: 'my', translations: '{"en":"Myanmar"}' },
    { code: 'MN', name: 'Mongolia', lat: 46, lng: 105, languages: 'mn', translations: '{"en":"Mongolia"}' },
    { code: 'MO', name: 'Macao', lat: 22.17, lng: 113.55, languages: 'zh,pt', translations: '{"en":"Macao"}' },
    { code: 'MP', name: 'Northern Mariana Islands', lat: 15.2, lng: 145.75, languages: 'en', translations: '{"en":"Northern Mariana Islands"}' },
    { code: 'MQ', name: 'Martinique', lat: 14.67, lng: -61, languages: 'fr', translations: '{"en":"Martinique"}' },
    { code: 'MR', name: 'Mauritania', lat: 20, lng: -12, languages: 'ar', translations: '{"en":"Mauritania"}' },
    { code: 'MS', name: 'Montserrat', lat: 16.75, lng: -62.2, languages: 'en', translations: '{"en":"Montserrat"}' },
    { code: 'MT', name: 'Malta', lat: 35.83, lng: 14.58, languages: 'mt,en', translations: '{"en":"Malta"}' },
    { code: 'MU', name: 'Mauritius', lat: -20.28, lng: 57.55, languages: 'en,fr', translations: '{"en":"Mauritius"}' },
    { code: 'MV', name: 'Maldives', lat: 3.25, lng: 73, languages: 'dv', translations: '{"en":"Maldives"}' },
    { code: 'MW', name: 'Malawi', lat: -13.5, lng: 34, languages: 'en,ny', translations: '{"en":"Malawi"}' },
    { code: 'MX', name: 'Mexico', lat: 23, lng: -102, languages: 'es', translations: '{"en":"Mexico"}' },
    { code: 'MY', name: 'Malaysia', lat: 2.5, lng: 112.5, languages: 'ms', translations: '{"en":"Malaysia"}' },
    { code: 'MZ', name: 'Mozambique', lat: -18.25, lng: 35, languages: 'pt', translations: '{"en":"Mozambique"}' },
    { code: 'NA', name: 'Namibia', lat: -22, lng: 17, languages: 'en,af', translations: '{"en":"Namibia"}' },
    { code: 'NC', name: 'New Caledonia', lat: -21.5, lng: 165.5, languages: 'fr', translations: '{"en":"New Caledonia"}' },
    { code: 'NE', name: 'Niger', lat: 16, lng: 8, languages: 'fr', translations: '{"en":"Niger"}' },
    { code: 'NF', name: 'Norfolk Island', lat: -29.04, lng: 167.95, languages: 'en', translations: '{"en":"Norfolk Island"}' },
    { code: 'NG', name: 'Nigeria', lat: 10, lng: 8, languages: 'en', translations: '{"en":"Nigeria"}' },
    { code: 'NI', name: 'Nicaragua', lat: 13, lng: -85, languages: 'es', translations: '{"en":"Nicaragua"}' },
    { code: 'NL', name: 'Netherlands', lat: 52.5, lng: 5.75, languages: 'nl', translations: '{"en":"Netherlands"}' },
    { code: 'NO', name: 'Norway', lat: 62, lng: 10, languages: 'no', translations: '{"en":"Norway"}' },
    { code: 'NP', name: 'Nepal', lat: 28, lng: 84, languages: 'ne', translations: '{"en":"Nepal"}' },
    { code: 'NR', name: 'Nauru', lat: -0.53, lng: 166.92, languages: 'na,en', translations: '{"en":"Nauru"}' },
    { code: 'NU', name: 'Niue', lat: -19.03, lng: -169.87, languages: 'en', translations: '{"en":"Niue"}' },
    { code: 'NZ', name: 'New Zealand', lat: -41, lng: 174, languages: 'en,mi', translations: '{"en":"New Zealand"}' },
    { code: 'OM', name: 'Oman', lat: 21, lng: 57, languages: 'ar', translations: '{"en":"Oman"}' },
    { code: 'PA', name: 'Panama', lat: 9, lng: -80, languages: 'es', translations: '{"en":"Panama"}' },
    { code: 'PE', name: 'Peru', lat: -10, lng: -76, languages: 'es,qu', translations: '{"en":"Peru"}' },
    { code: 'PF', name: 'French Polynesia', lat: -15, lng: -140, languages: 'fr', translations: '{"en":"French Polynesia"}' },
    { code: 'PG', name: 'Papua New Guinea', lat: -6, lng: 147, languages: 'en', translations: '{"en":"Papua New Guinea"}' },
    { code: 'PH', name: 'Philippines', lat: 13, lng: 122, languages: 'en,tl', translations: '{"en":"Philippines"}' },
    { code: 'PK', name: 'Pakistan', lat: 30, lng: 70, languages: 'ur,en', translations: '{"en":"Pakistan"}' },
    { code: 'PL', name: 'Poland', lat: 52, lng: 20, languages: 'pl', translations: '{"en":"Poland"}' },
    { code: 'PM', name: 'Saint Pierre and Miquelon', lat: 46.83, lng: -56.33, languages: 'fr', translations: '{"en":"Saint Pierre and Miquelon"}' },
    { code: 'PN', name: 'Pitcairn', lat: -24.7, lng: -127.4, languages: 'en', translations: '{"en":"Pitcairn"}' },
    { code: 'PR', name: 'Puerto Rico', lat: 18.25, lng: -66.5, languages: 'es,en', translations: '{"en":"Puerto Rico"}' },
    { code: 'PS', name: 'Palestine', lat: 32, lng: 35.25, languages: 'ar', translations: '{"en":"Palestine"}' },
    { code: 'PT', name: 'Portugal', lat: 39.5, lng: -8, languages: 'pt', translations: '{"en":"Portugal"}' },
    { code: 'PW', name: 'Palau', lat: 7.5, lng: 134.5, languages: 'en', translations: '{"en":"Palau"}' },
    { code: 'PY', name: 'Paraguay', lat: -23, lng: -58, languages: 'es,gn', translations: '{"en":"Paraguay"}' },
    { code: 'QA', name: 'Qatar', lat: 25.5, lng: 51.25, languages: 'ar', translations: '{"en":"Qatar"}' },
    { code: 'RE', name: 'Réunion', lat: -21.1, lng: 55.6, languages: 'fr', translations: '{"en":"Réunion"}' },
    { code: 'RO', name: 'Romania', lat: 46, lng: 25, languages: 'ro', translations: '{"en":"Romania"}' },
    { code: 'RS', name: 'Serbia', lat: 44, lng: 21, languages: 'sr', translations: '{"en":"Serbia"}' },
    { code: 'RU', name: 'Russia', lat: 60, lng: 100, languages: 'ru', translations: '{"en":"Russia"}' },
    { code: 'RW', name: 'Rwanda', lat: -2, lng: 30, languages: 'rw,en,fr', translations: '{"en":"Rwanda"}' },
    { code: 'SA', name: 'Saudi Arabia', lat: 25, lng: 45, languages: 'ar', translations: '{"en":"Saudi Arabia"}' },
    { code: 'SB', name: 'Solomon Islands', lat: -8, lng: 159, languages: 'en', translations: '{"en":"Solomon Islands"}' },
    { code: 'SC', name: 'Seychelles', lat: -4.58, lng: 55.67, languages: 'en,fr', translations: '{"en":"Seychelles"}' },
    { code: 'SD', name: 'Sudan', lat: 15, lng: 30, languages: 'ar,en', translations: '{"en":"Sudan"}' },
    { code: 'SE', name: 'Sweden', lat: 62, lng: 15, languages: 'sv', translations: '{"en":"Sweden"}' },
    { code: 'SG', name: 'Singapore', lat: 1.37, lng: 103.8, languages: 'en,ms,ta,zh', translations: '{"en":"Singapore"}' },
    { code: 'SH', name: 'Saint Helena', lat: -15.93, lng: -5.7, languages: 'en', translations: '{"en":"Saint Helena"}' },
    { code: 'SI', name: 'Slovenia', lat: 46, lng: 15, languages: 'sl', translations: '{"en":"Slovenia"}' },
    { code: 'SJ', name: 'Svalbard', lat: 78, lng: 20, languages: 'no', translations: '{"en":"Svalbard"}' },
    { code: 'SK', name: 'Slovakia', lat: 48.67, lng: 19.5, languages: 'sk', translations: '{"en":"Slovakia"}' },
    { code: 'SL', name: 'Sierra Leone', lat: 8.5, lng: -11.5, languages: 'en', translations: '{"en":"Sierra Leone"}' },
    { code: 'SM', name: 'San Marino', lat: 43.93, lng: 12.46, languages: 'it', translations: '{"en":"San Marino"}' },
    { code: 'SN', name: 'Senegal', lat: 14, lng: -14, languages: 'fr', translations: '{"en":"Senegal"}' },
    { code: 'SO', name: 'Somalia', lat: 10, lng: 49, languages: 'so,ar', translations: '{"en":"Somalia"}' },
    { code: 'SR', name: 'Suriname', lat: 4, lng: -56, languages: 'nl', translations: '{"en":"Suriname"}' },
    { code: 'SS', name: 'South Sudan', lat: 8, lng: 30, languages: 'en', translations: '{"en":"South Sudan"}' },
    { code: 'ST', name: 'São Tomé and Príncipe', lat: 1, lng: 7, languages: 'pt', translations: '{"en":"São Tomé and Príncipe"}' },
    { code: 'SV', name: 'El Salvador', lat: 13.83, lng: -88.92, languages: 'es', translations: '{"en":"El Salvador"}' },
    { code: 'SX', name: 'Sint Maarten', lat: 18.03, lng: -63.05, languages: 'nl,en', translations: '{"en":"Sint Maarten"}' },
    { code: 'SY', name: 'Syria', lat: 35, lng: 38, languages: 'ar', translations: '{"en":"Syria"}' },
    { code: 'SZ', name: 'Eswatini', lat: -26.5, lng: 31.5, languages: 'en,ss', translations: '{"en":"Eswatini"}' },
    { code: 'TC', name: 'Turks and Caicos Islands', lat: 21.75, lng: -71.58, languages: 'en', translations: '{"en":"Turks and Caicos Islands"}' },
    { code: 'TD', name: 'Chad', lat: 15, lng: 19, languages: 'fr,ar', translations: '{"en":"Chad"}' },
    { code: 'TF', name: 'French Southern Territories', lat: -49.25, lng: 69.17, languages: 'fr', translations: '{"en":"French Southern Territories"}' },
    { code: 'TG', name: 'Togo', lat: 8, lng: 1.17, languages: 'fr', translations: '{"en":"Togo"}' },
    { code: 'TH', name: 'Thailand', lat: 15, lng: 100, languages: 'th', translations: '{"en":"Thailand"}' },
    { code: 'TJ', name: 'Tajikistan', lat: 39, lng: 71, languages: 'tg,ru', translations: '{"en":"Tajikistan"}' },
    { code: 'TK', name: 'Tokelau', lat: -9, lng: -172, languages: 'en', translations: '{"en":"Tokelau"}' },
    { code: 'TL', name: 'East Timor', lat: -8.55, lng: 125.52, languages: 'pt,tet', translations: '{"en":"East Timor"}' },
    { code: 'TM', name: 'Turkmenistan', lat: 40, lng: 60, languages: 'tk', translations: '{"en":"Turkmenistan"}' },
    { code: 'TN', name: 'Tunisia', lat: 34, lng: 9, languages: 'ar', translations: '{"en":"Tunisia"}' },
    { code: 'TO', name: 'Tonga', lat: -20, lng: -175, languages: 'en,to', translations: '{"en":"Tonga"}' },
    { code: 'TR', name: 'Turkey', lat: 39, lng: 35, languages: 'tr', translations: '{"en":"Turkey"}' },
    { code: 'TT', name: 'Trinidad and Tobago', lat: 11, lng: -61, languages: 'en', translations: '{"en":"Trinidad and Tobago"}' },
    { code: 'TV', name: 'Tuvalu', lat: -8, lng: 178, languages: 'en', translations: '{"en":"Tuvalu"}' },
    { code: 'TW', name: 'Taiwan', lat: 23.5, lng: 121, languages: 'zh', translations: '{"en":"Taiwan"}' },
    { code: 'TZ', name: 'Tanzania', lat: -6, lng: 35, languages: 'sw,en', translations: '{"en":"Tanzania"}' },
    { code: 'UA', name: 'Ukraine', lat: 49, lng: 32, languages: 'uk', translations: '{"en":"Ukraine"}' },
    { code: 'UG', name: 'Uganda', lat: 1, lng: 32, languages: 'en,sw', translations: '{"en":"Uganda"}' },
    { code: 'UM', name: 'United States Minor Outlying Islands', lat: 19.28, lng: 166.6, languages: 'en', translations: '{"en":"United States Minor Outlying Islands"}' },
    { code: 'US', name: 'United States', lat: 39.8283, lng: -98.5795, languages: 'en', translations: '{"en":"United States","es":"Estados Unidos","fr":"États-Unis","de":"Vereinigte Staaten"}' },
    { code: 'UY', name: 'Uruguay', lat: -33, lng: -56, languages: 'es', translations: '{"en":"Uruguay"}' },
    { code: 'UZ', name: 'Uzbekistan', lat: 41, lng: 64, languages: 'uz,ru', translations: '{"en":"Uzbekistan"}' },
    { code: 'VA', name: 'Vatican City', lat: 41.9, lng: 12.45, languages: 'it,la', translations: '{"en":"Vatican City"}' },
    { code: 'VC', name: 'Saint Vincent and the Grenadines', lat: 13.25, lng: -61.2, languages: 'en', translations: '{"en":"Saint Vincent and the Grenadines"}' },
    { code: 'VE', name: 'Venezuela', lat: 8, lng: -66, languages: 'es', translations: '{"en":"Venezuela"}' },
    { code: 'VG', name: 'British Virgin Islands', lat: 18.5, lng: -64.5, languages: 'en', translations: '{"en":"British Virgin Islands"}' },
    { code: 'VI', name: 'United States Virgin Islands', lat: 18.35, lng: -64.93, languages: 'en', translations: '{"en":"United States Virgin Islands"}' },
    { code: 'VN', name: 'Vietnam', lat: 16, lng: 106, languages: 'vi', translations: '{"en":"Vietnam"}' },
    { code: 'VU', name: 'Vanuatu', lat: -16, lng: 167, languages: 'bi,en,fr', translations: '{"en":"Vanuatu"}' },
    { code: 'WF', name: 'Wallis and Futuna', lat: -13.3, lng: -176.2, languages: 'fr', translations: '{"en":"Wallis and Futuna"}' },
    { code: 'WS', name: 'Samoa', lat: -13.58, lng: -172.33, languages: 'sm,en', translations: '{"en":"Samoa"}' },
    { code: 'YE', name: 'Yemen', lat: 15, lng: 48, languages: 'ar', translations: '{"en":"Yemen"}' },
    { code: 'YT', name: 'Mayotte', lat: -12.83, lng: 45.17, languages: 'fr', translations: '{"en":"Mayotte"}' },
    { code: 'ZA', name: 'South Africa', lat: -29, lng: 24, languages: 'af,en,nr,st,ss,tn,ts,ve,xh,zu', translations: '{"en":"South Africa"}' },
    { code: 'ZM', name: 'Zambia', lat: -15, lng: 30, languages: 'en', translations: '{"en":"Zambia"}' },
    { code: 'ZW', name: 'Zimbabwe', lat: -20, lng: 30, languages: 'en,sn,nd', translations: '{"en":"Zimbabwe"}' }
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
  
  console.log('📊 Importing alternate names with aggressive memory management...');
  if (SUPPORTED_LANGUAGES) {
    console.log(`🌍 Filtering for languages: ${SUPPORTED_LANGUAGES.join(', ')}`);
  } else {
    console.log('🌍 Loading all languages');
  }
  
  let count = 0;
  let processed = 0;
  let batch = [];
  const BATCH_SIZE = 100; // Much smaller batches
  let stream = null;
  
  // Process single row immediately
  const processRow = async (row) => {
    try {
      // Check if the geonameid exists in our cities table
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
        
        return 1;
      }
    } catch (error) {
      // Skip invalid rows
    }
    return 0;
  };
  
  // Process batch with backpressure control
  const processBatch = async (batchData) => {
    if (batchData.length === 0) return 0;
    
    // Pause the stream while processing
    if (stream) stream.pause();
    
    let batchCount = 0;
    for (const row of batchData) {
      batchCount += await processRow(row);
    }
    
    // Force garbage collection
    if (global.gc) {
      global.gc();
    }
    
    // Resume the stream
    if (stream) stream.resume();
    
    return batchCount;
  };
  
  return new Promise((resolve, reject) => {
    const readline = require('readline');
    
    const fileStream = fs.createReadStream(txtFile);
    const rl = readline.createInterface({
      input: fileStream,
      crlfDelay: Infinity
    });
    
    let isProcessing = false;
    let lineQueue = [];
    
    // Process lines synchronously with proper backpressure
    const processLine = (line) => {
      processed++;
      
      // Parse TSV line manually to avoid CSV parser memory overhead
      const columns = line.split('\t');
      if (columns.length < 8) return; // Skip invalid lines
      
      const row = {
        alternatenameid: columns[0],
        geonameid: columns[1],
        isolanguage: columns[2],
        alternate_name: columns[3],
        is_preferred_name: columns[4],
        is_short_name: columns[5],
        is_colloquial: columns[6],
        is_historic: columns[7]
      };
      
      // Only process rows with valid language codes and names
      if (row.isolanguage && row.isolanguage.length <= 7 && row.alternate_name && row.alternate_name.length <= 400) {
        // Filter by supported languages if specified
        const shouldInclude = !SUPPORTED_LANGUAGES || 
          SUPPORTED_LANGUAGES.includes(row.isolanguage.toLowerCase()) ||
          SUPPORTED_LANGUAGES.includes('all');
        
        if (shouldInclude) {
          batch.push(row);
        }
      }
      
      if (processed % 50000 === 0) {
        console.log(`📥 Processed ${processed} alternate names, imported ${count}...`);
        // Force garbage collection more frequently
        if (global.gc) {
          global.gc();
        }
      }
    };
    
    const processQueue = async () => {
      if (isProcessing) return;
      isProcessing = true;
      
      // Process all queued lines
      while (lineQueue.length > 0) {
        const line = lineQueue.shift();
        processLine(line);
        
        // Process batch when it reaches the batch size
        if (batch.length >= BATCH_SIZE) {
          rl.pause(); // Pause reading while processing
          const batchCount = await processBatch(batch);
          count += batchCount;
          batch = []; // Clear batch array
          rl.resume(); // Resume reading
        }
      }
      
      isProcessing = false;
    };
    
    rl.on('line', (line) => {
      lineQueue.push(line);
      
      // Pause if queue gets too big
      if (lineQueue.length > 1000) {
        rl.pause();
        processQueue().then(() => {
          if (lineQueue.length < 500) {
            rl.resume();
          }
        });
      } else {
        // Process queue without pausing for small queues
        setImmediate(processQueue);
      }
    });
    
    rl.on('close', async () => {
      // Process any remaining queued lines
      await processQueue();
      
      // Process remaining items in batch
      if (batch.length > 0) {
        const batchCount = await processBatch(batch);
        count += batchCount;
      }
      
      console.log(`✅ Imported ${count} alternate names successfully`);
      resolve();
    });
    
    rl.on('error', reject);
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