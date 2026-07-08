#!/usr/bin/env python3
"""
Script to analyze Reddit comments and extract patterns for improving comment generation.
"""

import os
import pandas as pd
import numpy as np
import json
import re
import nltk
from nltk.tokenize import word_tokenize, sent_tokenize
from nltk.corpus import stopwords
from collections import Counter, defaultdict
import matplotlib.pyplot as plt
import seaborn as sns
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.cluster import KMeans
from sklearn.decomposition import PCA
import spacy
import emoji
import string
from wordcloud import WordCloud

# Create results directory
RESULTS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "results")
os.makedirs(RESULTS_DIR, exist_ok=True)

# Download necessary NLTK data
nltk.download('punkt', quiet=True)
nltk.download('stopwords', quiet=True)

# Load spaCy model
try:
    nlp = spacy.load("en_core_web_sm")
except OSError:
    print("Downloading spaCy model...")
    os.system("python -m spacy download en_core_web_sm")
    nlp = spacy.load("en_core_web_sm")

def load_dataset(sample_size=None):
    """Load the Reddit comments dataset."""
    data_file = os.path.join(os.path.dirname(os.path.abspath(__file__)), "reddit_comments.csv")
    
    if not os.path.exists(data_file):
        print(f"Dataset file not found: {data_file}")
        return None
    
    print(f"Loading dataset from {data_file}...")
    if sample_size:
        df = pd.read_csv(data_file, nrows=sample_size)
        print(f"Loaded sample of {sample_size:,} comments")
    else:
        df = pd.read_csv(data_file)
        print(f"Loaded full dataset with {len(df):,} comments")
    
    return df

def clean_text(text):
    """Clean and normalize text."""
    if pd.isna(text):
        return ""
    
    # Convert to string if not already
    text = str(text)
    
    # Remove URLs
    text = re.sub(r'http\S+', '', text)
    
    # Remove Reddit-specific formatting
    text = re.sub(r'\[.*?\]\(.*?\)', '', text)  # Remove markdown links
    text = re.sub(r'&amp;', '&', text)  # Replace HTML entities
    text = re.sub(r'&lt;', '<', text)
    text = re.sub(r'&gt;', '>', text)
    
    # Remove special characters but keep emojis
    text = ''.join(c for c in text if c.isalnum() or c.isspace() or c in string.punctuation or emoji.is_emoji(c))
    
    return text.strip()

def analyze_comment_structure(df):
    """Analyze the structure of comments."""
    print("Analyzing comment structure...")
    
    # Add cleaned text column
    df['cleaned_text'] = df['body'].apply(clean_text)
    
    # Calculate basic metrics
    df['word_count'] = df['cleaned_text'].apply(lambda x: len(word_tokenize(x)) if x else 0)
    df['sentence_count'] = df['cleaned_text'].apply(lambda x: len(sent_tokenize(x)) if x else 0)
    df['avg_sentence_length'] = df.apply(
        lambda row: row['word_count'] / row['sentence_count'] if row['sentence_count'] > 0 else 0, 
        axis=1
    )
    df['char_count'] = df['cleaned_text'].apply(len)
    df['has_emoji'] = df['cleaned_text'].apply(lambda x: any(emoji.is_emoji(c) for c in x))
    df['emoji_count'] = df['cleaned_text'].apply(lambda x: sum(emoji.is_emoji(c) for c in x))
    df['has_question'] = df['cleaned_text'].apply(lambda x: '?' in x)
    df['has_exclamation'] = df['cleaned_text'].apply(lambda x: '!' in x)
    df['has_hashtag'] = df['body'].apply(lambda x: '#' in str(x))
    
    # Calculate metrics by subreddit
    subreddit_stats = df.groupby('subreddit').agg({
        'word_count': ['mean', 'median', 'std'],
        'sentence_count': ['mean', 'median'],
        'avg_sentence_length': ['mean', 'median'],
        'char_count': ['mean', 'median'],
        'has_emoji': 'mean',
        'emoji_count': 'mean',
        'has_question': 'mean',
        'has_exclamation': 'mean',
        'has_hashtag': 'mean',
        'score': ['mean', 'median', 'max']
    }).reset_index()
    
    # Save results
    subreddit_stats.to_csv(os.path.join(RESULTS_DIR, 'subreddit_comment_stats.csv'), index=False)
    
    # Create visualizations
    plt.figure(figsize=(12, 8))
    sns.barplot(x='subreddit', y=('word_count', 'mean'), data=subreddit_stats.sort_values(('word_count', 'mean'), ascending=False).head(20))
    plt.title('Average Comment Word Count by Subreddit')
    plt.xticks(rotation=90)
    plt.tight_layout()
    plt.savefig(os.path.join(RESULTS_DIR, 'avg_word_count_by_subreddit.png'))
    
    # Emoji usage
    plt.figure(figsize=(12, 8))
    sns.barplot(x='subreddit', y=('has_emoji', 'mean'), data=subreddit_stats.sort_values(('has_emoji', 'mean'), ascending=False).head(20))
    plt.title('Emoji Usage by Subreddit')
    plt.xticks(rotation=90)
    plt.tight_layout()
    plt.savefig(os.path.join(RESULTS_DIR, 'emoji_usage_by_subreddit.png'))
    
    # Question usage
    plt.figure(figsize=(12, 8))
    sns.barplot(x='subreddit', y=('has_question', 'mean'), data=subreddit_stats.sort_values(('has_question', 'mean'), ascending=False).head(20))
    plt.title('Question Usage by Subreddit')
    plt.xticks(rotation=90)
    plt.tight_layout()
    plt.savefig(os.path.join(RESULTS_DIR, 'question_usage_by_subreddit.png'))
    
    # Hashtag usage
    plt.figure(figsize=(12, 8))
    sns.barplot(x='subreddit', y=('has_hashtag', 'mean'), data=subreddit_stats.sort_values(('has_hashtag', 'mean'), ascending=False).head(20))
    plt.title('Hashtag Usage by Subreddit')
    plt.xticks(rotation=90)
    plt.tight_layout()
    plt.savefig(os.path.join(RESULTS_DIR, 'hashtag_usage_by_subreddit.png'))
    
    # Score correlation with features
    score_correlations = {
        'word_count': df['word_count'].corr(df['score']),
        'sentence_count': df['sentence_count'].corr(df['score']),
        'avg_sentence_length': df['avg_sentence_length'].corr(df['score']),
        'char_count': df['char_count'].corr(df['score']),
        'has_emoji': df['has_emoji'].corr(df['score']),
        'emoji_count': df['emoji_count'].corr(df['score']),
        'has_question': df['has_question'].corr(df['score']),
        'has_exclamation': df['has_exclamation'].corr(df['score']),
        'has_hashtag': df['has_hashtag'].corr(df['score'])
    }
    
    with open(os.path.join(RESULTS_DIR, 'score_correlations.json'), 'w') as f:
        json.dump(score_correlations, f, indent=2)
    
    return df

def analyze_language_patterns(df):
    """Analyze language patterns in comments."""
    print("Analyzing language patterns...")
    
    # Get high-scoring comments (top 10%)
    high_score_threshold = df['score'].quantile(0.9)
    high_score_comments = df[df['score'] >= high_score_threshold]
    
    # Extract common phrases and patterns
    stop_words = set(stopwords.words('english'))
    
    def extract_ngrams(text, n=2):
        tokens = word_tokenize(text.lower())
        tokens = [token for token in tokens if token.isalnum() and token not in stop_words]
        ngrams = [' '.join(tokens[i:i+n]) for i in range(len(tokens)-n+1)]
        return ngrams
    
    # Extract bigrams and trigrams from high-scoring comments
    all_bigrams = []
    all_trigrams = []
    
    for text in high_score_comments['cleaned_text']:
        if pd.isna(text) or not text:
            continue
        all_bigrams.extend(extract_ngrams(text, 2))
        all_trigrams.extend(extract_ngrams(text, 3))
    
    # Count frequencies
    bigram_counter = Counter(all_bigrams)
    trigram_counter = Counter(all_trigrams)
    
    # Save most common n-grams
    with open(os.path.join(RESULTS_DIR, 'common_bigrams.json'), 'w') as f:
        json.dump(dict(bigram_counter.most_common(100)), f, indent=2)
    
    with open(os.path.join(RESULTS_DIR, 'common_trigrams.json'), 'w') as f:
        json.dump(dict(trigram_counter.most_common(100)), f, indent=2)
    
    # Create word clouds
    bigram_text = ' '.join(bigram for bigram, count in bigram_counter.most_common(100))
    wordcloud = WordCloud(width=800, height=400, background_color='white').generate(bigram_text)
    plt.figure(figsize=(10, 5))
    plt.imshow(wordcloud, interpolation='bilinear')
    plt.axis('off')
    plt.title('Common Bigrams in High-Scoring Comments')
    plt.tight_layout()
    plt.savefig(os.path.join(RESULTS_DIR, 'high_score_bigrams_wordcloud.png'))
    
    # Analyze sentiment and tone
    sentiment_scores = []
    
    for doc in nlp.pipe(high_score_comments['cleaned_text'].dropna().sample(min(1000, len(high_score_comments))).tolist()):
        # Simple sentiment analysis based on polarity lexicon
        positive_words = sum(1 for token in doc if token.is_alpha and token._.in_polarity_lexicon and token._.polarity > 0)
        negative_words = sum(1 for token in doc if token.is_alpha and token._.in_polarity_lexicon and token._.polarity < 0)
        
        sentiment_scores.append({
            'positive_ratio': positive_words / max(len(doc), 1),
            'negative_ratio': negative_words / max(len(doc), 1),
            'question_marks': doc.text.count('?'),
            'exclamation_marks': doc.text.count('!'),
            'personal_pronouns': sum(1 for token in doc if token.pos_ == 'PRON' and token.text.lower() in ['i', 'me', 'my', 'mine', 'myself'])
        })
    
    sentiment_df = pd.DataFrame(sentiment_scores)
    sentiment_stats = {
        'positive_ratio_mean': sentiment_df['positive_ratio'].mean(),
        'negative_ratio_mean': sentiment_df['negative_ratio'].mean(),
        'question_marks_mean': sentiment_df['question_marks'].mean(),
        'exclamation_marks_mean': sentiment_df['exclamation_marks'].mean(),
        'personal_pronouns_mean': sentiment_df['personal_pronouns'].mean()
    }
    
    with open(os.path.join(RESULTS_DIR, 'high_score_sentiment_stats.json'), 'w') as f:
        json.dump(sentiment_stats, f, indent=2)
    
    return high_score_comments

def identify_comment_styles(df, n_clusters=5):
    """Identify different comment styles using clustering."""
    print("Identifying comment styles...")
    
    # Sample comments for clustering (for performance)
    sample_size = min(10000, len(df))
    sample_df = df.sample(sample_size)
    
    # Create TF-IDF features
    tfidf = TfidfVectorizer(max_features=1000, stop_words='english')
    tfidf_matrix = tfidf.fit_transform(sample_df['cleaned_text'].fillna(''))
    
    # Add structural features
    features = np.hstack((
        tfidf_matrix.toarray(),
        sample_df[['word_count', 'sentence_count', 'has_question', 'has_exclamation']].values
    ))
    
    # Perform clustering
    kmeans = KMeans(n_clusters=n_clusters, random_state=42)
    clusters = kmeans.fit_predict(features)
    
    # Add cluster labels to the sample
    sample_df['cluster'] = clusters
    
    # Analyze each cluster
    cluster_stats = []
    for cluster_id in range(n_clusters):
        cluster_comments = sample_df[sample_df['cluster'] == cluster_id]
        
        stats = {
            'cluster_id': cluster_id,
            'size': len(cluster_comments),
            'avg_score': cluster_comments['score'].mean(),
            'avg_word_count': cluster_comments['word_count'].mean(),
            'avg_sentence_count': cluster_comments['sentence_count'].mean(),
            'question_ratio': cluster_comments['has_question'].mean(),
            'exclamation_ratio': cluster_comments['has_exclamation'].mean(),
            'emoji_ratio': cluster_comments['has_emoji'].mean(),
            'example_comments': cluster_comments.sort_values('score', ascending=False)['body'].head(5).tolist()
        }
        
        cluster_stats.append(stats)
    
    # Save cluster stats
    with open(os.path.join(RESULTS_DIR, 'comment_style_clusters.json'), 'w') as f:
        json.dump(cluster_stats, f, indent=2)
    
    # Visualize clusters with PCA
    pca = PCA(n_components=2)
    coords = pca.fit_transform(features)
    
    plt.figure(figsize=(10, 8))
    for cluster_id in range(n_clusters):
        cluster_points = coords[clusters == cluster_id]
        plt.scatter(cluster_points[:, 0], cluster_points[:, 1], label=f'Cluster {cluster_id}')
    
    plt.title('Comment Style Clusters')
    plt.legend()
    plt.savefig(os.path.join(RESULTS_DIR, 'comment_style_clusters.png'))
    
    return cluster_stats

def extract_comment_templates(high_score_comments):
    """Extract comment templates from high-scoring comments."""
    print("Extracting comment templates...")
    
    # Sample of high-scoring comments
    sample_size = min(1000, len(high_score_comments))
    sample = high_score_comments.sample(sample_size)
    
    # Process comments with spaCy to extract patterns
    templates = []
    
    for doc in nlp.pipe(sample['cleaned_text'].dropna().tolist()):
        # Skip very short comments
        if len(doc) < 5:
            continue
        
        # Create a template by replacing specific entities with placeholders
        template = []
        for token in doc:
            if token.ent_type_ in ('PERSON', 'ORG', 'GPE', 'LOC'):
                template.append(f"[{token.ent_type_}]")
            elif token.like_num:
                template.append("[NUMBER]")
            elif token.is_punct or token.is_space:
                template.append(token.text)
            else:
                template.append(token.text)
        
        templates.append(' '.join(template))
    
    # Count template frequencies
    template_counter = Counter(templates)
    
    # Save most common templates
    with open(os.path.join(RESULTS_DIR, 'comment_templates.json'), 'w') as f:
        json.dump(dict(template_counter.most_common(100)), f, indent=2)
    
    return template_counter

def generate_insights(df, high_score_comments, cluster_stats):
    """Generate insights for improving comment generation."""
    print("Generating insights...")
    
    # Calculate overall statistics
    overall_stats = {
        'total_comments': len(df),
        'avg_word_count': df['word_count'].mean(),
        'median_word_count': df['word_count'].median(),
        'avg_sentence_count': df['sentence_count'].mean(),
        'median_sentence_count': df['sentence_count'].median(),
        'emoji_usage_rate': df['has_emoji'].mean(),
        'question_usage_rate': df['has_question'].mean(),
        'exclamation_usage_rate': df['has_exclamation'].mean(),
        'hashtag_usage_rate': df['has_hashtag'].mean()
    }
    
    # High-scoring comment statistics
    high_score_stats = {
        'total_high_score_comments': len(high_score_comments),
        'avg_word_count': high_score_comments['word_count'].mean(),
        'median_word_count': high_score_comments['word_count'].median(),
        'avg_sentence_count': high_score_comments['sentence_count'].mean(),
        'median_sentence_count': high_score_comments['sentence_count'].median(),
        'emoji_usage_rate': high_score_comments['has_emoji'].mean(),
        'question_usage_rate': high_score_comments['has_question'].mean(),
        'exclamation_usage_rate': high_score_comments['has_exclamation'].mean(),
        'hashtag_usage_rate': high_score_comments['has_hashtag'].mean()
    }
    
    # Identify best performing cluster
    best_cluster = sorted(cluster_stats, key=lambda x: x['avg_score'], reverse=True)[0]
    
    # Generate recommendations
    recommendations = {
        'optimal_comment_length': {
            'words': int(high_score_comments['word_count'].median()),
            'sentences': int(high_score_comments['sentence_count'].median())
        },
        'engagement_elements': {
            'use_questions': high_score_comments['has_question'].mean() > df['has_question'].mean(),
            'use_exclamations': high_score_comments['has_exclamation'].mean() > df['has_exclamation'].mean(),
            'use_emojis': high_score_comments['has_emoji'].mean() > df['has_emoji'].mean(),
            'avoid_hashtags': high_score_comments['has_hashtag'].mean() < df['has_hashtag'].mean()
        },
        'best_performing_style': {
            'cluster_id': best_cluster['cluster_id'],
            'characteristics': {
                'avg_word_count': best_cluster['avg_word_count'],
                'avg_sentence_count': best_cluster['avg_sentence_count'],
                'question_ratio': best_cluster['question_ratio'],
                'exclamation_ratio': best_cluster['exclamation_ratio'],
                'emoji_ratio': best_cluster['emoji_ratio']
            },
            'example_comments': best_cluster['example_comments'][:3]
        }
    }
    
    # Combine all insights
    insights = {
        'overall_stats': overall_stats,
        'high_score_stats': high_score_stats,
        'recommendations': recommendations
    }
    
    # Save insights
    with open(os.path.join(RESULTS_DIR, 'comment_generation_insights.json'), 'w') as f:
        json.dump(insights, f, indent=2)
    
    # Create a summary markdown file
    with open(os.path.join(RESULTS_DIR, 'summary.md'), 'w') as f:
        f.write("# Reddit Comment Analysis Summary\n\n")
        
        f.write("## Overall Statistics\n\n")
        f.write(f"- Total comments analyzed: {overall_stats['total_comments']:,}\n")
        f.write(f"- Average word count: {overall_stats['avg_word_count']:.1f}\n")
        f.write(f"- Median word count: {overall_stats['median_word_count']:.1f}\n")
        f.write(f"- Average sentence count: {overall_stats['avg_sentence_count']:.1f}\n")
        f.write(f"- Emoji usage rate: {overall_stats['emoji_usage_rate']:.1%}\n")
        f.write(f"- Question usage rate: {overall_stats['question_usage_rate']:.1%}\n")
        f.write(f"- Exclamation usage rate: {overall_stats['exclamation_usage_rate']:.1%}\n")
        f.write(f"- Hashtag usage rate: {overall_stats['hashtag_usage_rate']:.1%}\n\n")
        
        f.write("## High-Scoring Comments\n\n")
        f.write(f"- Total high-scoring comments: {high_score_stats['total_high_score_comments']:,}\n")
        f.write(f"- Average word count: {high_score_stats['avg_word_count']:.1f}\n")
        f.write(f"- Median word count: {high_score_stats['median_word_count']:.1f}\n")
        f.write(f"- Average sentence count: {high_score_stats['avg_sentence_count']:.1f}\n")
        f.write(f"- Emoji usage rate: {high_score_stats['emoji_usage_rate']:.1%}\n")
        f.write(f"- Question usage rate: {high_score_stats['question_usage_rate']:.1%}\n")
        f.write(f"- Exclamation usage rate: {high_score_stats['exclamation_usage_rate']:.1%}\n")
        f.write(f"- Hashtag usage rate: {high_score_stats['hashtag_usage_rate']:.1%}\n\n")
        
        f.write("## Recommendations for Comment Generation\n\n")
        f.write(f"- Optimal comment length: {recommendations['optimal_comment_length']['words']} words, {recommendations['optimal_comment_length']['sentences']} sentences\n")
        f.write("- Engagement elements:\n")
        f.write(f"  - {'Use' if recommendations['engagement_elements']['use_questions'] else 'Limit'} questions\n")
        f.write(f"  - {'Use' if recommendations['engagement_elements']['use_exclamations'] else 'Limit'} exclamations\n")
        f.write(f"  - {'Use' if recommendations['engagement_elements']['use_emojis'] else 'Limit'} emojis\n")
        f.write(f"  - {'Avoid' if recommendations['engagement_elements']['avoid_hashtags'] else 'Consider using'} hashtags\n\n")
        
        f.write("## Best Performing Comment Style\n\n")
        f.write(f"- Average word count: {recommendations['best_performing_style']['characteristics']['avg_word_count']:.1f}\n")
        f.write(f"- Average sentence count: {recommendations['best_performing_style']['characteristics']['avg_sentence_count']:.1f}\n")
        f.write(f"- Question ratio: {recommendations['best_performing_style']['characteristics']['question_ratio']:.1%}\n")
        f.write(f"- Exclamation ratio: {recommendations['best_performing_style']['characteristics']['exclamation_ratio']:.1%}\n")
        f.write(f"- Emoji ratio: {recommendations['best_performing_style']['characteristics']['emoji_ratio']:.1%}\n\n")
        
        f.write("### Example High-Performing Comments\n\n")
        for i, comment in enumerate(recommendations['best_performing_style']['example_comments'], 1):
            f.write(f"{i}. {comment}\n\n")
    
    return insights

def main():
    """Main function to analyze Reddit comments."""
    print("Starting Reddit comment analysis...")
    
    # Load dataset (use a sample for faster processing)
    sample_size = 100000  # Adjust based on your system's capabilities
    df = load_dataset(sample_size)
    
    if df is None:
        return
    
    # Analyze comment structure
    df = analyze_comment_structure(df)
    
    # Analyze language patterns
    high_score_comments = analyze_language_patterns(df)
    
    # Identify comment styles
    cluster_stats = identify_comment_styles(df)
    
    # Extract comment templates
    extract_comment_templates(high_score_comments)
    
    # Generate insights
    insights = generate_insights(df, high_score_comments, cluster_stats)
    
    print(f"\nAnalysis complete! Results saved to {RESULTS_DIR}")
    print("Key insights:")
    print(f"- Optimal comment length: {insights['recommendations']['optimal_comment_length']['words']} words")
    print(f"- Use questions: {'Yes' if insights['recommendations']['engagement_elements']['use_questions'] else 'No'}")
    print(f"- Use exclamations: {'Yes' if insights['recommendations']['engagement_elements']['use_exclamations'] else 'No'}")
    print(f"- Use emojis: {'Yes' if insights['recommendations']['engagement_elements']['use_emojis'] else 'No'}")
    print(f"- Avoid hashtags: {'Yes' if insights['recommendations']['engagement_elements']['avoid_hashtags'] else 'No'}")

if __name__ == "__main__":
    main()