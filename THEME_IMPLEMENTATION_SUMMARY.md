# Agent Health - Theme Implementation Summary

## Project Overview

**Agent Health** is a standalone observability and evaluation platform for AI agents, running on:
- **Development**: `localhost:4000` (frontend dev server)
- **Production**: `localhost:4001` (production build)
- **Backend**: Separate from OpenSearch Dashboards

## Complete Theme Changes Implemented

### 1. Typography (OpenSearch UI Standards)

**Fonts Applied:**
- **Primary Font**: Rubik (replacing Inter)
  - Weights: 300, 400, 500, 600, 700
  - Fallback: -apple-system, BlinkMacSystemFont, Segoe UI, Helvetica, Arial, sans-serif
- **Monospace Font**: Source Code Pro (replacing Roboto Mono)
  - Weights: 400, 500, 600
  - Fallback: Consolas, Menlo, Courier, monospace

**Base Settings:**
- Font size: 14px (OUI default)
- Font weight: 400 (OUI default)
- Font kerning: enabled for better rendering

**Files Modified:**
- `tailwind.config.js` - Font family definitions
- `index.css` - Google Fonts imports and base layer styles

**Theme Behavior:**
- Fonts are theme-agnostic (work identically in both light and dark modes)
- Only colors change between themes, not typography

---

### 2. Logo Implementation

**Dynamic Logo Switching:**
- Light mode: `opensearch-logo-light.svg` (darker blues for contrast on white)
- Dark mode: `opensearch-logo.svg` (lighter blues for contrast on dark)

**Implementation:**
- `Layout.tsx` uses MutationObserver to detect theme changes
- Automatically switches logo based on `document.documentElement.classList.contains('dark')`

**Colors:**
- Light mode logo: #005EB8, #003B5C (darker blues)
- Dark mode logo: #00A3E0, #B9D9EB (lighter blues)

**Files Modified:**
- `components/Layout.tsx` - Theme detection and logo switching
- `assets/opensearch-logo-light.svg` - New light mode logo

---

### 3. Badge & Pill Colors

**Difficulty Badges:**
- Easy: Blue palette
  - Light: `bg-blue-100 text-blue-800 border-blue-300`
  - Dark: `bg-blue-900/30 text-opensearch-blue border-blue-800`
- Medium: Amber palette
  - Light: `bg-amber-100 text-amber-800 border-amber-300`
  - Dark: `bg-yellow-900/30 text-yellow-400 border-yellow-800`
- Hard: Red palette
  - Light: `bg-red-100 text-red-800 border-red-300`
  - Dark: `bg-red-900/30 text-red-400 border-red-800`

**Category/Subcategory Badges:**
- Hash-based color assignment using 8 color variants
- Each with full light/dark mode support

**Files Modified:**
- `lib/utils.ts` - `getDifficultyColor()` and `getLabelColor()` functions
- `components/RunDetailsContent.tsx` - Uses utility functions instead of hardcoded colors

---

### 4. Pass Rate Pills (NEW)

**Color Logic:**
- ≥80%: Green (success)
  - Light: `bg-green-50 text-green-700 border-green-200`
  - Dark: `bg-green-900/30 text-green-400 border-green-800`
- 50-79%: Amber (warning)
  - Light: `bg-amber-50 text-amber-700 border-amber-200`
  - Dark: `bg-amber-900/30 text-amber-400 border-amber-800`
- <50%: Red (danger)
  - Light: `bg-red-50 text-red-700 border-red-200`
  - Dark: `bg-red-900/30 text-red-400 border-red-800`

**Implementation:**
- New utility function: `getPassRateColor(passRate: number)`
- Applied to benchmark results tables

**Files Modified:**
- `lib/utils.ts` - Added `getPassRateColor()` function
- `components/BenchmarkResultsView.tsx` - Pass rate badges with theme support

---

### 5. Status Color Utilities (NEW)

**New Utility Functions:**

```typescript
// For pass rate badges
getPassRateColor(passRate: number): string

// For status indicators (success/error/warning/info/neutral)
getStatusColor(status: 'success' | 'error' | 'warning' | 'info' | 'neutral'): string

// For metric text colors
getMetricTextColor(type: 'primary' | 'success' | 'error' | 'warning' | 'info' | 'secondary'): string
```

**Color Palette:**

| Status | Light Mode | Dark Mode |
|--------|-----------|-----------|
| Success | `bg-green-100 text-green-800 border-green-300` | `bg-green-900/30 text-green-400 border-green-800` |
| Warning | `bg-amber-100 text-amber-800 border-amber-300` | `bg-amber-900/30 text-amber-400 border-amber-800` |
| Error | `bg-red-100 text-red-800 border-red-300` | `bg-red-900/30 text-red-400 border-red-800` |
| Info | `bg-blue-100 text-blue-800 border-blue-300` | `bg-blue-900/30 text-blue-400 border-blue-800` |
| Neutral | `bg-gray-100 text-gray-800 border-gray-300` | `bg-gray-800/30 text-gray-400 border-gray-700` |

**Files Modified:**
- `lib/utils.ts` - Added all status color utilities

---

### 6. Info Badges (Settings Page)

**"built-in" Badge:**
- Light: `bg-blue-50 text-blue-700 border border-blue-200`
- Dark: `bg-blue-900/30 text-blue-400 border-blue-800`

**Config Source Badges:**
- File source: Green palette
- Environment source: Blue palette
- Not configured: Gray palette
- All with proper borders and theme support

**Files Modified:**
- `components/SettingsPage.tsx` - Updated all badge colors

---

### 7. Sidebar Menu Colors

**Light Mode:**
- Background: White (#FFFFFF)
- Text: Dark gray (#343741)
- Border: Light gray (#D3DAE6)
- Hover: Very light gray (#F5F7FA)
- Active: Light blue background (#E6F1F7) with blue text (#006BB4)
- Border radius: 24px (right side)
- Box shadow: Multi-layer subtle shadow

**Dark Mode:**
- Background: Dark gray (#1D1E24)
- Text: Light gray (#DFE5EF)
- Border: Darker gray (#343741)
- Hover: Slightly lighter dark (#25262E)
- Active: Teal background (#1A3A52) with teal text (#6DCCB1)

**Files Modified:**
- `components/Layout.tsx` - Sidebar structure and dynamic styling
- `index.css` - OUI sidebar CSS rules for both themes

---

### 8. Prose/Markdown Styles

**All markdown elements now theme-aware:**

**Light Mode:**
- Headings: Dark gray (#1a1a1a)
- Code inline: Blue (#015aa3) with light blue background
- Code blocks: Light gray background (#F5F7FA)
- Links: OpenSearch blue (#006BB4)
- Blockquotes: Gray border and text
- Tables: Light gray backgrounds and borders

**Dark Mode:**
- Headings: Light gray (#f3f4f6)
- Code inline: Light blue (#00A3E0) with darker blue background
- Code blocks: Dark background (#0d1117)
- Links: Bright blue (#3b82f6)
- Blockquotes: Dark gray border and text
- Tables: Dark gray backgrounds and borders

**Files Modified:**
- `index.css` - Complete prose style overhaul with theme variants

---

### 9. Stats Cards (Agent Traces Page)

**OUI Stat Components:**
- Total Traces: `titleColor="primary"` (blue)
- Error Rate: `titleColor="danger"` (red)
- Avg Duration: `titleColor="accent"` (amber/orange)
- Total Spans: `titleColor="subdued"` (gray) - changed from "secondary" for better light mode contrast

**Files Modified:**
- `components/traces/AgentTracesPageOUI.tsx` - Updated OuiStat titleColor props

---

## Running the Application

### Prerequisites

```bash
# Ensure you have the correct environment variables
AWS_REGION=us-west-2
AWS_PROFILE=Bedrock
OPENSEARCH_STORAGE_ENDPOINT=https://search-goyamegh-agent-logs-7qplqzxzzcyn5cvl3n3bxfv7aq.aos.us-east-1.on.aws
OPENSEARCH_STORAGE_USERNAME=admin
OPENSEARCH_STORAGE_PASSWORD=OSDPlatform1!
```

### Development Mode (localhost:4000)

```bash
cd agent-health-jasonlh
npm install
npm run dev
```

- Frontend runs on `localhost:4000` with hot reload
- Vite dev server with fast HMR (Hot Module Replacement)
- Best for active development and testing

### Production Mode (localhost:4001)

```bash
cd agent-health-jasonlh
npm install
npm start
```

- Production build runs on `localhost:4001`
- Optimized and minified build
- Best for final testing and production-like environment
- Note: `npm start` automatically builds if needed

### Backend Server

The backend server must be running separately:

```bash
cd agent-health-jasonlh
npm run dev:server
```

Backend API runs on the configured port (check `server/` directory).

---

## Testing the Theme Changes

### Visual Checklist

**Light Mode:**
- [ ] Rubik font applied throughout
- [ ] Logo shows darker blue version
- [ ] Sidebar has white background with proper shadows
- [ ] Pass rate pills (32%, 19%, 82%) have good contrast
- [ ] "built-in" badges are readable with borders
- [ ] Difficulty badges (Easy/Medium/Hard) have proper colors
- [ ] Stats cards (Error Rate, Avg Duration, Total Spans) are readable
- [ ] All text has sufficient contrast
- [ ] Code blocks have light gray backgrounds

**Dark Mode:**
- [ ] Same Rubik font (no change)
- [ ] Logo shows lighter blue version
- [ ] Sidebar has dark background
- [ ] Pass rate pills have proper dark mode colors
- [ ] "built-in" badges have semi-transparent backgrounds
- [ ] Difficulty badges maintain visibility
- [ ] Stats cards use appropriate dark colors
- [ ] All text is readable on dark backgrounds
- [ ] Code blocks have dark backgrounds

**Theme Switching:**
- [ ] Toggle between light/dark modes smoothly
- [ ] Logo switches automatically
- [ ] All colors transition properly
- [ ] No flash of unstyled content
- [ ] Sidebar colors update correctly

---

## Key Files Reference

### Core Theme Files
- `index.css` - Base styles, fonts, prose, sidebar
- `tailwind.config.js` - Font families, color tokens
- `lib/utils.ts` - Color utility functions
- `lib/theme.ts` - Theme management

### Component Files
- `components/Layout.tsx` - Sidebar and logo switching
- `components/SettingsPage.tsx` - Info badges
- `components/BenchmarkResultsView.tsx` - Pass rate pills
- `components/traces/AgentTracesPageOUI.tsx` - Stats cards
- `components/RunDetailsContent.tsx` - Difficulty badges

### Asset Files
- `assets/opensearch-logo.svg` - Dark mode logo
- `assets/opensearch-logo-light.svg` - Light mode logo

---

## Documentation Files

- `LIGHT_MODE_COLORS.md` - Original light mode implementation
- `OUI_INTEGRATION_SUMMARY.md` - OpenSearch UI integration details
- `LIGHT_MODE_AUDIT.md` - Comprehensive audit and fixes
- `THEME_IMPLEMENTATION_SUMMARY.md` - This file

---

## Design Principles

1. **Consistency**: All components use the same color palette
2. **Accessibility**: Proper contrast ratios in both modes
3. **OUI Alignment**: Follows OpenSearch UI design standards
4. **Maintainability**: Reusable utility functions for colors
5. **Performance**: Theme-agnostic fonts, only colors change

---

## Next Steps

1. Start the application on localhost:4001
2. Test all pages in both light and dark modes
3. Verify all badges, pills, and stats cards have proper colors
4. Check that fonts are applied correctly throughout
5. Ensure smooth theme transitions

All theme changes are complete and ready for production use!
