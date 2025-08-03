# Lightweight GeoNames API

A production-ready, lightweight GeoNames API with multilingual support, fuzzy search, and autocomplete.

## System Requirements

### Minimum Requirements
- **CPU**: 2 cores
- **RAM**: 4GB (2GB during import, 1GB runtime)
- **Storage**: 2GB free space
- **Network**: Internet access for GeoNames data download

### Recommended Requirements
- **CPU**: 4+ cores
- **RAM**: 8GB (for faster imports and better performance)
- **Storage**: 5GB free space
- **Network**: Stable internet connection (downloads ~100MB of data)

### Container Requirements
- **Docker**: Version 20.10+ 
- **Docker Compose**: Version 2.0+
- **Platform**: Linux/amd64, Linux/arm64 supported

## Features

- 🌍 **Global Coverage**: Cities with population >15,000 worldwide
- 🗣️ **Multilingual**: Configurable language support from GeoNames
- 🔍 **Fuzzy Search**: Handles typos and misspellings
- ⚡ **Autocomplete**: Fast-as-you-type suggestions
- 🔐 **API Key Authentication**: Secure access control
- 📍 **Reverse Geocoding**: Find places by coordinates
- 🚀 **Production Ready**: Health checks, optimized queries
- 💾 **Lightweight**: ~500MB storage for global cities
- 🛠️ **Memory Optimized**: Efficient batch processing for large datasets

## Quick Start

1. **Copy environment file**:
   ```bash
   cp .env.example .env
   # Edit .env with your settings
   ```

2. **Deploy to Coolify**:
   - Create new project in Coolify
   - Choose "Docker Compose" build pack
   - Point to this repository
   - Set environment variables from .env

3. **Wait for data import** (5-30 minutes):
   - The `data-loader` container downloads and imports GeoNames data
   - Import time depends on dataset size and language configuration
   - Check logs: `docker-compose logs data-loader`

4. **Test the API**:
   ```bash
   # Health check
   curl http://localhost:3000/health
   
   # Search with API key
   curl -H "X-API-Key: your-api-key-1" \
        "http://localhost:3000/search?q=london&autocomplete=true"
   ```

## API Endpoints

### GET /search
Search for cities and countries with fuzzy matching and autocomplete.

**Parameters**:
- `q` (required): Search query (min 2 characters)
- `country` (optional): Filter by country code (e.g., "US", "GB")
- `type` (optional): Filter by type ("city" or "country")
- `autocomplete` (optional): Enable autocomplete mode (default: false)
- `limit` (optional): Max results (default: 10 for autocomplete, 20 for search)

**Authentication**: Include `X-API-Key` header or `api_key` query parameter

**Example**:
```bash
curl -H "X-API-Key: your-key" \
     "http://localhost:3000/search?q=lond&autocomplete=true&limit=5"
```

**Response**:
```json
{
  "query": "lond",
  "results": [
    {
      "type": "city",
      "name": "London",
      "country_code": "GB",
      "country_name": "United Kingdom",
      "admin_region": "England",
      "coordinates": [51.5074, -0.1278],
      "name_translations": {
        "en": "London",
        "fr": "Londres",
        "de": "London"
      }
    }
  ],
  "count": 1,
  "autocomplete": true
}
```

### GET /reverse
Find places near coordinates.

**Parameters**:
- `lat` (required): Latitude
- `lon` (required): Longitude  
- `radius` (optional): Search radius in km (default: 50)

**Example**:
```bash
curl -H "X-API-Key: your-key" \
     "http://localhost:3000/reverse?lat=51.5074&lon=-0.1278"
```

### GET /health
Health check endpoint (no authentication required).

## Configuration

### Environment Variables

- `POSTGRES_PASSWORD`: Database password (required)
- `API_KEYS`: Comma-separated list of valid API keys
- `GEONAMES_DATASET`: Dataset size (cities15000, cities5000, cities1000)
- `SUPPORTED_LANGUAGES`: Languages for alternate names (optional)

#### Language Configuration

Control which languages to import for multilingual support:

```bash
# Load specific languages (reduces memory usage and import time)
SUPPORTED_LANGUAGES=en,es,fr,de,ar,zh,ja,ru,pt,it

# Load only English and Spanish
SUPPORTED_LANGUAGES=en,es

# Load all languages (default if not set)
# SUPPORTED_LANGUAGES=

# Or explicitly load all
SUPPORTED_LANGUAGES=all
```

**Common language codes**: `en` (English), `es` (Spanish), `fr` (French), `de` (German), `ar` (Arabic), `zh` (Chinese), `ja` (Japanese), `ru` (Russian), `pt` (Portuguese), `it` (Italian), `ko` (Korean), `hi` (Hindi)

### Storage Requirements

| Dataset | Size | Cities | Population | Recommended |
|---------|------|--------|------------|-------------|
| **cities15000** | ~500MB | 2.2M | >15,000 | ✅ Best balance |
| **cities5000** | ~800MB | 3.7M | >5,000 | Good coverage |
| **cities1000** | ~1.5GB | 7.5M | >1,000 | Maximum data |

### Memory Usage by Configuration

| Configuration | Import RAM | Runtime RAM | Import Time |
|---------------|------------|-------------|-------------|
| All languages | 3-4GB | 1-2GB | 20-30 min |
| 10 languages | 2-3GB | 1GB | 10-15 min |
| 3 languages | 1-2GB | 512MB | 5-10 min |

## Performance

- **Concurrent Users**: 50+ supported
- **Query Speed**: <100ms typical response time
- **Import Time**: 5-30 minutes (depends on dataset and languages)
- **Memory Usage**: 1-4GB during import, 512MB-2GB runtime
- **Storage**: 500MB-1.5GB depending on dataset

## Security

- API key authentication on all endpoints
- PostgreSQL not exposed externally
- Non-root containers
- CORS and security headers enabled

## Monitoring

Check container health:
```bash
docker-compose ps
docker-compose logs api
```

API health check:
```bash
curl http://localhost:3000/health
```

## Troubleshooting

### Memory Issues During Import
If you encounter "JavaScript heap out of memory" errors:

1. **Reduce language scope**:
   ```bash
   SUPPORTED_LANGUAGES=en,es,fr
   ```

2. **Use smaller dataset**:
   ```bash
   GEONAMES_DATASET=cities15000  # instead of cities5000 or cities1000
   ```

3. **Increase container memory limit** (if using Docker/Kubernetes)

### Import Taking Too Long
- Check available system resources (CPU, RAM, disk I/O)
- Consider using fewer languages with `SUPPORTED_LANGUAGES`
- Monitor logs: `docker-compose logs -f data-loader`

### API Performance Issues
- Check database indexes are created properly
- Monitor memory usage during runtime
- Consider adding Redis caching for high-traffic deployments

## Scaling

For higher loads:
- Increase PostgreSQL `max_connections`
- Add read replicas
- Use Redis caching
- Load balance multiple API instances
- Consider using a smaller language subset to reduce memory usage