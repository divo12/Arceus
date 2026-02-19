#!/bin/bash

# Script to create the GitHub repository and push the PM branch
# This requires a GitHub personal access token

set -e

GITHUB_TOKEN="${1:-$GITHUB_TOKEN}"
REPO_NAME="Arceus"
USERNAME="divo12"

if [ -z "$GITHUB_TOKEN" ]; then
    echo "Error: GitHub token is required"
    echo ""
    echo "To create a GitHub personal access token:"
    echo "1. Go to https://github.com/settings/tokens"
    echo "2. Click 'Generate new token' -> 'Generate new token (classic)'"
    echo "3. Select 'repo' scope"
    echo "4. Copy the token"
    echo ""
    echo "Then run: GITHUB_TOKEN=your_token ./setup_repo.sh"
    echo "Or: ./setup_repo.sh your_token"
    exit 1
fi

echo "Creating private GitHub repository: $USERNAME/$REPO_NAME"

# Create the repository via GitHub API
RESPONSE=$(curl -s -w "\n%{http_code}" -X POST \
  -H "Accept: application/vnd.github.v3+json" \
  -H "Authorization: token $GITHUB_TOKEN" \
  https://api.github.com/user/repos \
  -d "{
    \"name\": \"$REPO_NAME\",
    \"private\": true,
    \"description\": \"Private repository\"
  }")

HTTP_CODE=$(echo "$RESPONSE" | tail -n1)
BODY=$(echo "$RESPONSE" | sed '$d')

if [ "$HTTP_CODE" -eq 201 ]; then
    echo "✓ Repository created successfully (private)"
elif [ "$HTTP_CODE" -eq 422 ]; then
    echo "⚠ Repository may already exist, continuing..."
    # Check if it's private
    CHECK_RESPONSE=$(curl -s -w "\n%{http_code}" \
      -H "Accept: application/vnd.github.v3+json" \
      -H "Authorization: token $GITHUB_TOKEN" \
      https://api.github.com/repos/$USERNAME/$REPO_NAME)
    
    CHECK_CODE=$(echo "$CHECK_RESPONSE" | tail -n1)
    if [ "$CHECK_CODE" -eq 200 ]; then
        IS_PRIVATE=$(echo "$CHECK_RESPONSE" | sed '$d' | grep -o '"private":[^,]*' | grep -o 'true\|false')
        if [ "$IS_PRIVATE" != "true" ]; then
            echo "⚠ Repository exists but is not private. Making it private..."
            curl -s -X PATCH \
              -H "Accept: application/vnd.github.v3+json" \
              -H "Authorization: token $GITHUB_TOKEN" \
              https://api.github.com/repos/$USERNAME/$REPO_NAME \
              -d '{"private": true}' > /dev/null
            echo "✓ Repository is now private"
        else
            echo "✓ Repository exists and is already private"
        fi
    fi
else
    echo "Error creating repository. HTTP Code: $HTTP_CODE"
    echo "$BODY"
    exit 1
fi

# Push the PM branch
echo ""
echo "Pushing PM branch to GitHub..."
cd /Users/divyansh/Arceus

# Check if we're on PM branch
CURRENT_BRANCH=$(git branch --show-current)
if [ "$CURRENT_BRANCH" != "PM" ]; then
    git checkout PM
fi

# Push PM branch
if git push -u origin PM 2>&1; then
    echo "✓ PM branch pushed successfully"
else
    echo "⚠ Push failed. You may need to push manually:"
    echo "  git push -u origin PM"
fi

echo ""
echo "✓ Setup complete!"
echo "  Repository: https://github.com/$USERNAME/$REPO_NAME (private)"
echo "  Branch: PM"
echo "  Remote: git@github.com:$USERNAME/$REPO_NAME.git"
