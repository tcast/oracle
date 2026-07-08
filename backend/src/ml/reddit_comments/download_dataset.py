#!/usr/bin/env python3
"""
Script to download and prepare the Reddit comments dataset from Kaggle.
"""

import os
import subprocess
import zipfile
import pandas as pd
import json

def setup_kaggle_credentials():
    """Check if Kaggle credentials are set up correctly."""
    kaggle_dir = os.path.expanduser('~/.kaggle')
    kaggle_json = os.path.join(kaggle_dir, 'kaggle.json')
    
    if not os.path.exists(kaggle_json):
        print("Kaggle API credentials not found.")
        print("Please follow these steps:")
        print("1. Create a Kaggle account at https://www.kaggle.com if you don't have one")
        print("2. Go to your Kaggle account settings (click on your profile picture > Account)")
        print("3. Scroll down to the API section and click 'Create New API Token'")
        print("4. This will download a kaggle.json file with your credentials")
        print("5. Create the directory ~/.kaggle if it doesn't exist")
        print("6. Move the downloaded kaggle.json file to ~/.kaggle/")
        print("7. Ensure the file has proper permissions: chmod 600 ~/.kaggle/kaggle.json")
        print("8. Run this script again")
        return False
    
    # Check permissions
    permissions = oct(os.stat(kaggle_json).st_mode)[-3:]
    if permissions != '600':
        print(f"Warning: Your kaggle.json file has permissions {permissions}, recommended: 600")
        print("Consider running: chmod 600 ~/.kaggle/kaggle.json")
    
    return True

def download_dataset():
    """Download the Reddit comments dataset from Kaggle."""
    dataset = "smagnan/1-million-reddit-comments-from-40-subreddits"
    output_dir = os.path.dirname(os.path.abspath(__file__))
    
    print(f"Downloading dataset from Kaggle: {dataset}")
    try:
        subprocess.run(
            ["kaggle", "datasets", "download", dataset, "--path", output_dir],
            check=True
        )
        print("Download completed successfully.")
        
        # Extract the zip file
        zip_file = os.path.join(output_dir, "1-million-reddit-comments-from-40-subreddits.zip")
        if os.path.exists(zip_file):
            print(f"Extracting {zip_file}...")
            with zipfile.ZipFile(zip_file, 'r') as zip_ref:
                zip_ref.extractall(output_dir)
            print("Extraction completed.")
            
            # Remove the zip file to save space
            os.remove(zip_file)
            print(f"Removed {zip_file}")
        else:
            print(f"Warning: Expected zip file {zip_file} not found.")
            
    except subprocess.CalledProcessError as e:
        print(f"Error downloading dataset: {e}")
        return False
    
    return True

def preview_dataset():
    """Preview the downloaded dataset."""
    data_file = os.path.join(os.path.dirname(os.path.abspath(__file__)), "reddit_comments.csv")
    
    if not os.path.exists(data_file):
        print(f"Dataset file not found: {data_file}")
        return
    
    try:
        # Load a sample of the data
        df = pd.read_csv(data_file, nrows=5)
        print("\nDataset preview (first 5 rows):")
        print(df.head())
        
        # Show dataset info
        print("\nDataset columns:")
        print(df.columns.tolist())
        
        # Count total rows
        with open(data_file, 'r', encoding='utf-8') as f:
            row_count = sum(1 for _ in f) - 1  # Subtract 1 for header
        
        print(f"\nTotal comments in dataset: {row_count:,}")
        
    except Exception as e:
        print(f"Error previewing dataset: {e}")

def main():
    """Main function to download and prepare the dataset."""
    print("Setting up Reddit comments dataset for ML analysis...")
    
    if not setup_kaggle_credentials():
        return
    
    if download_dataset():
        preview_dataset()
        print("\nDataset is ready for analysis!")
        print("Next steps:")
        print("1. Run the analysis script: python analyze_comments.py")
        print("2. Check the generated insights in the 'results' directory")

if __name__ == "__main__":
    main()