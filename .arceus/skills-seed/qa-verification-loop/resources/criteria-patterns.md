# Decomposing Vague Acceptance Criteria

When the task says "login should work", turn it into checkable statements before you verify.

## Pattern 1: "X works"

```
✗ "login works"
✓ "POST /api/auth with valid credentials returns 200 + session cookie"
✓ "invalid credentials return 401 with no session"
✓ "rate limit returns 429 after 6 attempts"
```

## Pattern 2: "X looks good"

```
✗ "form looks clean"
✓ "form labels are visible at 320px viewport width"
✓ "error messages render red (#dc2626) within 2 lines of the input"
✓ "submit button is disabled while request is pending"
```

## Pattern 3: "X is fast"

```
✗ "fast page load"
✓ "Largest Contentful Paint < 2.5s on emulated Slow 4G"
✓ "Time to Interactive < 5s on the same profile"
```

If you cannot decompose a criterion into a checkable statement, block the task with `cause: "criteria_ambiguous"` and list the unclear items.
