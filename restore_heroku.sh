#!/bin/bash

echo "Creating backup of local database..."
PGPASSWORD=your_password pg_dump -Fc --no-acl --no-owner -h localhost -U postgres oracle > latest.dump

if [ $? -ne 0 ]; then
    echo "Error: Failed to create local backup"
    exit 1
fi


echo "Resetting Heroku database..."
heroku pg:reset --confirm socialoracle DATABASE_URL

if [ $? -ne 0 ]; then
    echo "Error: Failed to reset Heroku database"
    exit 1
fi

echo "Pushing local database to Heroku..."
heroku pg:push postgres://localhost/oracle DATABASE_URL

if [ $? -ne 0 ]; then
    echo "Error: Failed to push to Heroku"
    exit 1
fi

echo "Database transfer completed successfully!"