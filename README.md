# Lightweight GeoNames API

A production-ready, lightweight GeoNames API with multilingual support, fuzzy search, and autocomplete.

## Features

- 🌍 **Global Coverage**: Cities with population >15,000 worldwide
- 🗣️ **Multilingual**: Full language support from GeoNames
- 🔍 **Fuzzy Search**: Handles typos and misspellings
- ⚡ **Autocomplete**: Fast-as-you-type suggestions
- 🔐 **API Key Authentication**: Secure access control
- 📍 **Reverse Geocoding**: Find places by coordinates
- 🚀 **Production Ready**: Health checks, optimized queries
- 💾 **Lightweight**: ~500MB storage for global cities

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

3. **Wait for data import** (5-10 minutes):
   - The `data-loader` container downloads and imports GeoNames data
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

### Storage Requirements

- **cities15000**: ~500MB (2.2M cities, pop >15k) ✅ Recommended
- **cities5000**: ~800MB (3.7M cities, pop >5k)
- **cities1000**: ~1.5GB (7.5M cities, pop >1k)

## Performance

- **Concurrent Users**: 50+ supported
- **Query Speed**: <100ms typical response time
- **Memory Usage**: ~2GB RAM total
- **Storage**: ~500MB for global cities

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

## Scaling

For higher loads:
- Increase PostgreSQL `max_connections`
- Add read replicas
- Use Redis caching
- Load balance multiple API instances