# Machine Learning for Oracle

This directory contains machine learning modules to enhance Oracle's functionality.

## Available Modules

### Reddit Comments Analysis

Located in `reddit_comments/`, this module analyzes a dataset of 1 million Reddit comments to improve comment generation across all platforms.

**Features:**
- Analyzes comment structure, length, and engagement patterns
- Identifies effective comment styles and templates
- Extracts insights on what makes comments engaging and authentic
- Integrates findings into the commenting service

**How to use:**

1. Set up Kaggle API credentials (see instructions in `reddit_comments/README.md`)
2. Run the analysis pipeline:
   ```
   cd backend/src/ml/reddit_comments
   ./run_analysis.sh
   ```
3. Check the `results` directory for detailed analysis outputs
4. The commenting service will be automatically updated with the insights

## Adding New ML Modules

To add a new ML module:

1. Create a new directory under `backend/src/ml/`
2. Include a README.md with documentation
3. Add requirements.txt for dependencies
4. Create analysis scripts and integration code
5. Update this README to include your new module