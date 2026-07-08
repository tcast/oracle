#!/bin/bash

# Configuration
POLYGON_DIR="/Users/tcast/Downloads/polygon"
STOCKS_PATH="us_stocks_sip/day_aggs_v1"
OUTPUT_FILE="/Users/tcast/Downloads/polygon/combined_stock_data.csv"

# Create output directory if it doesn't exist
mkdir -p $(dirname "$OUTPUT_FILE")

echo "Starting to combine Polygon.io stock data files..."

# Count all files
echo "Counting files..."
TOTAL_FILES=$(find "$POLYGON_DIR/$STOCKS_PATH" -name "*.csv.gz" | wc -l)
echo "Found $TOTAL_FILES files to process"

# Check if any files were found
if [ "$TOTAL_FILES" -eq 0 ]; then
  echo "No .csv.gz files found in $POLYGON_DIR/$STOCKS_PATH"
  exit 1
fi

# Initialize counter
COUNT=0

# Get the first file to extract header
FIRST_FILE=$(find "$POLYGON_DIR/$STOCKS_PATH" -name "*.csv.gz" | head -1)

if [ -n "$FIRST_FILE" ]; then
  echo "Extracting header from $FIRST_FILE"
  gunzip -c "$FIRST_FILE" | head -1 > "$OUTPUT_FILE"
else
  echo "No files found to process"
  exit 1
fi

# Process each .csv.gz file
find "$POLYGON_DIR/$STOCKS_PATH" -name "*.csv.gz" | while read file; do
  COUNT=$((COUNT+1))
  
  # Print progress every 10 files
  if [ $((COUNT % 10)) -eq 0 ]; then
    echo "Processing file $COUNT/$TOTAL_FILES: $(basename "$file")"
  fi
  
  # Extract data without header (skip first line)
  gunzip -c "$file" | tail -n +2 >> "$OUTPUT_FILE"
  
  # Show progress periodically
  if [ $((COUNT % 100)) -eq 0 ]; then
    echo "Processed $COUNT/$TOTAL_FILES files ($(printf "%.1f" $(echo "scale=1; $COUNT*100/$TOTAL_FILES" | bc))%)"
  fi
done

echo "Process complete! All data combined into $OUTPUT_FILE"
echo "Total files processed: $COUNT"

# Show file size
FILE_SIZE=$(du -h "$OUTPUT_FILE" | cut -f1)
echo "Combined file size: $FILE_SIZE"