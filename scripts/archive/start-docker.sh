#!/bin/bash

echo "🐳 Starting Oracle application with Docker..."

# Check if Docker is running
if ! docker info > /dev/null 2>&1; then
    echo "❌ Docker is not running. Please start Docker Desktop first."
    echo "Opening Docker Desktop..."
    open -a Docker
    echo "⏳ Waiting for Docker to start..."
    
    # Wait for Docker to be ready
    while ! docker info > /dev/null 2>&1; do
        sleep 2
        echo "⏳ Still waiting for Docker..."
    done
    
    echo "✅ Docker is now running!"
fi

# Stop any existing containers
echo "🔄 Stopping existing containers..."
docker-compose down || true

# Build and start the application
echo "🏗️  Building and starting containers..."
docker-compose up --build -d

# Wait for containers to be ready
echo "⏳ Waiting for containers to be ready..."
sleep 10

# Check container status
echo "📊 Container status:"
docker-compose ps

# Show logs
echo "📋 Recent logs:"
docker-compose logs --tail=20

echo ""
echo "🎉 Oracle application is starting up!"
echo "📱 Frontend: http://localhost:3020"
echo "🔌 Backend API: http://localhost:3021"
echo ""
echo "📝 To view logs: docker-compose logs -f"
echo "🛑 To stop: docker-compose down"