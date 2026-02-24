# OpenSearch UI (OUI) Integration Summary

This document summarizes the changes made to align the Agent Health project with OpenSearch UI design standards.

## Typography

### Font Families
The project now uses the same fonts as OpenSearch Dashboards:

**Primary Font: Rubik**
```css
font-family: 'Rubik', -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif, 'Apple Color Emoji', 'Segoe UI Emoji', 'Segoe UI Symbol';
```

**Monospace Font: Source Code Pro**
```css
font-family: 'Source Code Pro', Consolas, Menlo, Courier, monospace;
```

### Font Specifications
- Base font size: 14px (OUI standard)
- Base font weight: 400
- Font kerning: enabled for better text rendering
- Weights available:
  - Rubik: 300, 400, 500, 600, 700
  - Source Code Pro: 400, 500, 600

### Implementation
1. Updated `tailwind.config.js` with new font families
2. Added Google Fonts imports in `index.css`
3. Applied base styles to body and code elements
4. Updated prose styles for markdown rendering

## Colors

### Badge Colors
All badges now support both light and dark modes with proper contrast:

**Light Mode:**
- Subtle backgrounds (100 shade)
- Darker text (800 shade)
- Lighter borders (300 shade)

**Dark Mode:**
- Semi-transparent darker backgrounds
- Lighter text (400 shade)
- Darker borders (800 shade)

### Difficulty Colors
- Easy: Blue palette
- Medium: Amber/Yellow palette
- Hard: Red palette

### Category/Subcategory Colors
8 color variants with hash-based assignment:
- Blue, Purple, Cyan, Pink, Orange, Teal, Indigo, Gray

## Logo

### Dynamic Logo Switching
The application now uses different logos based on the theme:

**Light Mode:**
- File: `assets/opensearch-logo-light.svg`
- Colors: Darker blues (#005EB8, #003B5C)
- Better contrast on white background

**Dark Mode:**
- File: `assets/opensearch-logo.svg`
- Colors: Lighter blues (#00A3E0, #B9D9EB)
- Better contrast on dark background

### Implementation
- Theme detection using MutationObserver
- Automatic logo switching on theme change
- No page refresh required

## Files Modified

### Configuration
- `tailwind.config.js` - Updated font families
- `index.css` - Added font imports and base styles

### Components
- `components/Layout.tsx` - Dynamic logo switching
- `components/RunDetailsContent.tsx` - Badge color utilities
- `lib/utils.ts` - Color utility functions

### Assets
- `assets/opensearch-logo-light.svg` - New light mode logo

## Testing

To verify the changes:
1. Start the dev server: `npm run dev`
2. Open http://localhost:4000
3. Check that fonts are Rubik (not Inter)
4. Toggle between light and dark modes
5. Verify logo changes appropriately
6. Check badge colors in both modes

## Browser Compatibility

The fonts are loaded from Google Fonts with proper fallbacks:
- Modern browsers: Rubik and Source Code Pro
- Fallback: System fonts (San Francisco, Segoe UI, etc.)
- All browsers: Proper font rendering with kerning

## Performance

- Fonts are loaded asynchronously via Google Fonts
- `display=swap` ensures text is visible during font loading
- Fallback fonts provide immediate rendering
- No layout shift due to proper font metrics

## Future Improvements

Consider:
1. Self-hosting fonts for better performance and offline support
2. Adding more OUI color tokens to Tailwind config
3. Implementing OUI spacing scale
4. Adding OUI animation/transition standards
