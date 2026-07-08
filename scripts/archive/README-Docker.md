# Oracle Application - Docker Setup

This document explains how to run the Oracle application using Docker.

## Prerequisites

- Docker Desktop installed and running
- At least 4GB RAM available for Docker
- Ports 3000 and 3020 available

## Quick Start

### Option 1: Using the startup script (Recommended)
```bash
./start-docker.sh
```

### Option 2: Manual Docker commands
```bash
# Start Docker Desktop if not running
open -a Docker

# Build and run containers
docker-compose up --build -d

# Check status
docker-compose ps

# View logs
docker-compose logs -f
```

## Application URLs

- **Frontend**: http://localhost:3020
- **Backend API**: http://localhost:3021
- **Health Check**: http://localhost:3021/api/health

## Useful Commands

### Container Management
```bash
# View running containers
docker-compose ps

# Stop containers
docker-compose down

# Restart containers
docker-compose restart

# Rebuild and restart
docker-compose up --build -d
```

### Logs and Debugging
```bash
# View all logs
docker-compose logs

# Follow logs in real-time
docker-compose logs -f

# View logs for specific service
docker-compose logs backend
docker-compose logs frontend

# Execute commands in running container
docker-compose exec backend sh
docker-compose exec frontend sh
```

### Database Access
The application connects to the external AWS RDS database as configured in the backend environment variables.

## Configuration

### Environment Variables
The backend uses the existing `.env` file in the `backend` directory. No additional configuration is needed.

### Port Configuration
- Frontend: Port 3020 (configurable in `frontend/vite.config.js`)
- Backend: Port 3021 (mapped from internal port 3000)

## Troubleshooting

### Docker Issues
1. **Docker not running**: Start Docker Desktop first
2. **Port conflicts**: Check if ports 3021 or 3020 are already in use
3. **Build failures**: Try `docker-compose build --no-cache`

### Container Issues
1. **Container won't start**: Check logs with `docker-compose logs [service]`
2. **Database connection**: Verify AWS RDS connectivity
3. **API not responding**: Check backend container logs

### Performance
- The application may take a few minutes to fully start
- Frontend build process can take 2-3 minutes
- Backend initialization includes database connection and API validation

## Development

### File Changes
- Backend: Changes require container rebuild (`docker-compose up --build`)
- Frontend: Changes require container rebuild for production build

### Volume Mounts
- Upload files are persisted in `./backend/uploads`
- Frontend serves static files from nginx

## Security Notes

- The application connects to production AWS RDS database
- API keys are loaded from the backend `.env` file
- Frontend is served via nginx with gzip compression
- All containers run as non-root users where possible