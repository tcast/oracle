#!/bin/bash

# Configuration
POLYGON_DIR="/Users/tcast/Downloads/polygon"
STOCKS_PATH="us_stocks_sip/day_aggs_v1"
OUTPUT_FILE="/Users/tcast/Downloads/polygon/combined_stock_data.csv"

echo "Starting CSV file combination process..."

# Create a temporary directory for uncompressed files
TEMP_DIR="/Users/tcast/Downloads/polygon/temp"
mkdir -p "$TEMP_DIR"

# Find all csv.gz files
echo "Finding all .csv.gz files..."
find "$POLYGON_DIR/$STOCKS_PATH" -name "*.csv.gz" -type f | sort > "$TEMP_DIR/file_list.txt"

# Count how many files we have
NUM_FILES=$(wc -l < "$TEMP_DIR/file_list.txt")
echo "Found $NUM_FILES .csv.gz files to process"

# Get the header from the first file
FIRST_FILE=$(head -n 1 "$TEMP_DIR/file_list.txt")
echo "Extracting header from: $FIRST_FILE"
zcat "$FIRST_FILE" | head -n 1 > "$OUTPUT_FILE"

# Process files one by one
echo "Processing files and appending to combined CSV..."
counter=0
while read -r file; do
  ((counter++))
  
  # Show progress every 100 files
  if ((counter % 100 == 0)) || ((counter == 1)) || ((counter == NUM_FILES)); then
    echo "Processing file $counter/$NUM_FILES: $(basename "$file")"
  fi
  
  # Skip header and append all other lines
  zcat "$file" | tail -n +2 >> "$OUTPUT_FILE"
done < "$TEMP_DIR/file_list.txt"

# Cleanup
rm -rf "$TEMP_DIR"

echo "Process complete! All data combined into $OUTPUT_FILE"
echo "Total files processed: $NUM_FILES"