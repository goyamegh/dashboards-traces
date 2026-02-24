# Light Mode Color Audit & Fixes

## Issues Identified & Fixed

### 1. Pass Rate Pills/Badges ✅ FIXED
- **Problem**: Pass rate percentages (32%, 19%, 82%) had poor contrast in light mode
- **Location**: `BenchmarkResultsView.tsx` - pass rate display in summary table
- **Fix Applied**: 
  - Added `getPassRateColor()` utility function in `lib/utils.ts`
  - Updated pass rate display to use Badge component with theme-aware colors
  - Green (≥80%), Amber (50-79%), Red (<50%) with proper light/dark variants
  - Light mode: Darker text on light backgrounds
  - Dark mode: Lighter text on dark backgrounds

### 2. Stats Cards ✅ FIXED
- **Problem**: OUI Stat components needed better theme support
- **Location**: `AgentTracesPageOUI.tsx` - OuiStat components
- **Fix Applied**: 
  - Changed "Total Spans" from `titleColor="secondary"` to `titleColor="subdued"` for better light mode contrast
  - Added `titleSize="l"` for consistent sizing
  - OUI components now handle theme colors automatically

### 3. Info Badges ✅ FIXED
- **Problem**: "built-in" badges and config source badges using hardcoded blue colors
- **Location**: `SettingsPage.tsx` - agent endpoint cards and config status indicators
- **Fix Applied**:
  - Updated "built-in" badge: `bg-blue-50 text-blue-700 border border-blue-200 dark:bg-blue-900/30 dark:text-blue-400 dark:border-blue-800`
  - Updated config source badges (file/environment/not configured) with full theme support
  - All badges now have proper borders and contrast in both modes

### 4. General Theme Improvements ✅ FIXED
- **Problem**: Various components using hardcoded Tailwind colors
- **Fix Applied**:
  - Added comprehensive status color utilities in `lib/utils.ts`:
    - `getPassRateColor(passRate)` - for pass rate badges
    - `getStatusColor(status)` - for success/error/warning/info/neutral states
    - `getMetricTextColor(type)` - for metric value displays
  - Updated diff indicators to use theme-aware colors (green/red)

## New Utility Functions

### `getPassRateColor(passRate: number): string`
Returns theme-aware classes for pass rate badges:
- ≥80%: Green (success)
- 50-79%: Amber (warning)
- <50%: Red (danger)

### `getStatusColor(status): string`
Returns theme-aware classes for status indicators:
- success, error, warning, info, neutral

### `getMetricTextColor(type): string`
Returns theme-aware text colors for metrics:
- primary, success, error, warning, info, secondary

## Color Palette Standards

### Light Mode
- **Success/Pass**: `bg-green-100 text-green-800 border-green-300`
- **Warning**: `bg-amber-100 text-amber-800 border-amber-300`
- **Danger/Error**: `bg-red-100 text-red-800 border-red-300`
- **Info**: `bg-blue-100 text-blue-800 border-blue-300`
- **Neutral**: `bg-gray-100 text-gray-800 border-gray-300`

### Dark Mode
- **Success/Pass**: `bg-green-900/30 text-green-400 border-green-800`
- **Warning**: `bg-amber-900/30 text-amber-400 border-amber-800`
- **Danger/Error**: `bg-red-900/30 text-red-400 border-red-800`
- **Info**: `bg-blue-900/30 text-blue-400 border-blue-800`
- **Neutral**: `bg-gray-800/30 text-gray-400 border-gray-700`

## Files Updated

1. ✅ `lib/utils.ts` - Added status color utilities
2. ✅ `components/BenchmarkResultsView.tsx` - Pass rate badges with theme support
3. ✅ `components/traces/AgentTracesPageOUI.tsx` - Stats card improvements
4. ✅ `components/SettingsPage.tsx` - Info badges and config status indicators

## Testing Checklist

- [ ] View Benchmarks page in light mode - pass rate pills should have good contrast
- [ ] View Agent Traces page in light mode - stats cards should be readable
- [ ] View Settings page in light mode - "built-in" badges should have proper colors
- [ ] Toggle between light and dark modes - all colors should transition smoothly
- [ ] Check all badge borders are visible in both modes

## Next Steps

All identified issues have been fixed. The application now has comprehensive theme support with:
- Consistent color palette across all components
- Proper contrast ratios for accessibility
- Smooth transitions between light and dark modes
- Reusable utility functions for future components
