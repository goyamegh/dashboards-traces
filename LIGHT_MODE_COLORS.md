# Light Mode Color Calibration & OUI Font Integration

## Overview
Updated badge/pill colors, logo, typography, and all UI elements to properly support both light and dark modes, following OpenSearch UI (OUI) design principles.

## Changes Made

### 1. Typography Updates
- **Primary Font**: Changed from Inter to Rubik (OUI standard)
  - Weights: 300, 400, 500, 600, 700
  - Fallback: -apple-system, BlinkMacSystemFont, Segoe UI, Helvetica, Arial, sans-serif
- **Monospace Font**: Changed from Roboto Mono to Source Code Pro (OUI standard)
  - Weights: 400, 500, 600
  - Fallback: Consolas, Menlo, Courier, monospace
- Updated `tailwind.config.js` font families
- Added Google Fonts imports for Rubik and Source Code Pro in `index.css`
- Set base font size to 14px (OUI default)
- Set base font weight to 400 (OUI default)
- Applied font-kerning for better text rendering
- Updated code/pre elements to use Source Code Pro
- **Fonts are theme-agnostic and work identically in both light and dark modes**
  - Font families are set at the base layer level (body, code, pre)
  - Only colors change between themes, not typography
  - All text elements inherit the correct fonts automatically

### 2. Logo Updates
- Added light mode logo: `assets/opensearch-logo-light.svg`
- Updated `Layout.tsx` to dynamically switch logos based on theme
- Light mode: Uses darker blue logo for better contrast on white background
- Dark mode: Uses original lighter logo

### 3. Updated `lib/utils.ts`
- Added Tailwind dark mode variants to all badge color definitions
- Light mode: Subtle backgrounds (100 shade) with darker text (800 shade)
- Dark mode: Darker backgrounds with lighter text (original colors preserved)

### 4. Color Palette

#### Difficulty Labels
- **Easy**: Blue palette
  - Light: `bg-blue-100 text-blue-800 border-blue-300`
  - Dark: `bg-blue-900/30 text-opensearch-blue border-blue-800`
  
- **Medium**: Amber/Yellow palette
  - Light: `bg-amber-100 text-amber-800 border-amber-300`
  - Dark: `bg-yellow-900/30 text-yellow-400 border-yellow-800`
  
- **Hard**: Red palette
  - Light: `bg-red-100 text-red-800 border-red-300`
  - Dark: `bg-red-900/30 text-red-400 border-red-800`

#### Category/Subcategory Labels
Hash-based color assignment using 8 color variants:
- Blue, Purple, Cyan, Pink, Orange, Teal, Indigo, Gray
- Each with light and dark mode variants

### 5. Updated Components
- `RunDetailsContent.tsx`: Replaced hardcoded colors with utility functions
  - Now uses `getDifficultyColor()` for difficulty badges
  - Now uses `getLabelColor()` for category/subcategory badges

## Design Principles

### Light Mode
- High contrast for readability
- Subtle backgrounds that don't overwhelm
- Darker text colors (800 shade) for accessibility
- Lighter borders (300 shade) for definition

### Dark Mode
- Preserved existing dark mode aesthetics
- Semi-transparent backgrounds for depth
- Lighter text colors for contrast
- Darker borders for subtle definition

## Testing
View the Test Cases page in both light and dark modes to see the updated badge colors.

## Future Improvements
Consider adding more OpenSearch-specific color tokens to the Tailwind config for better brand consistency.


## Logo Implementation

The Layout component now includes theme detection:
- Uses `MutationObserver` to watch for theme changes on `document.documentElement`
- Dynamically switches between light and dark logos
- Light mode logo sourced from OpenSearch Dashboards: `http://localhost:5601/ui/logos/opensearch_mark_on_light.svg`


### 6. Prose/Markdown Styles
Updated all markdown prose styles to support both themes:

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

### 7. Sidebar Menu Colors
Fixed sidebar to properly support both themes:

**Light Mode:**
- Background: White (#FFFFFF)
- Text: Dark gray (#343741)
- Border: Light gray (#D3DAE6)
- Hover: Very light gray (#F5F7FA)
- Active: Light blue background (#E6F1F7) with blue text (#006BB4)

**Dark Mode:**
- Background: Dark gray (#1D1E24)
- Text: Light gray (#DFE5EF)
- Border: Darker gray (#343741)
- Hover: Slightly lighter dark (#25262E)
- Active: Teal background (#1A3A52) with teal text (#6DCCB1)
