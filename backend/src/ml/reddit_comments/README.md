# Reddit Comments Analysis for Comment Generation

This module analyzes Reddit comments to improve our comment generation across all platforms.

## Setup Instructions

1. Create a Kaggle account at https://www.kaggle.com if you don't have one
2. Go to your Kaggle account settings (click on your profile picture > Account)
3. Scroll down to the API section and click "Create New API Token"
4. This will download a `kaggle.json` file with your credentials
5. Place this file in `~/.kaggle/` directory (create it if it doesn't exist)
6. Ensure the file has proper permissions: `chmod 600 ~/.kaggle/kaggle.json`

## Dataset

We're using the "1 Million Reddit Comments from 40 Subreddits" dataset:
https://www.kaggle.com/datasets/smagnan/1-million-reddit-comments-from-40-subreddits/code

## Analysis Goals

1. Understand comment structure patterns across different subreddits
2. Identify common engagement patterns and effective comment styles
3. Train models to generate more authentic and diverse comments
4. Improve our comment generation system with these insights