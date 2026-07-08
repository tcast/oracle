#!/bin/bash

# Script to run the Reddit comments analysis pipeline

# Set up environment
echo "Setting up environment..."
pip install -r requirements.txt
python -m spacy download en_core_web_sm

# Download the dataset
echo "Downloading dataset from Kaggle..."
python download_dataset.py

# Run the analysis
echo "Running comment analysis..."
python analyze_comments.py

# Integrate insights
echo "Integrating insights into the commenting service..."
node integrate_insights.js

echo "Analysis pipeline complete!"
echo "Check the 'results' directory for detailed analysis outputs."