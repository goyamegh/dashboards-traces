# Figma Design Specifications

## Design File
- **File**: Agentic Observability
- **File ID**: 6EeCG3PZxXhdQUbIStmAT4
- **Node ID**: 32:44908 (M3 Left Nav)
- **Last Modified**: 2026-02-13

## Color Themes
The design uses OUI (OpenSearch UI) color system with multiple theme modes:

### Available Themes
1. **Theme Light** (Mode ID: 5:2)
2. **Theme Dark** (Mode ID: 9:5)
3. **Trinity Light** (Mode ID: 548:2)
4. **Trinity Dark** (Mode ID: 552:0) - Currently used in the design
5. Next Dark (Mode ID: 185:5)
6. Next Light (Mode ID: 185:6)

## Component Structure

### M3 Left Nav (Main Navigation)
- **Type**: Frame
- **Component**: left nav header with logo variant
- **Features**:
  - Logo/branding area
  - Search functionality
  - Collapsible menu items
  - Status indicator at bottom

### Key Design Elements
1. **Header**
   - OpenSearch logo
   - Application title
   - Search bar

2. **Navigation Items**
   - Overview
   - Agent Traces
   - Evals (collapsible)
     - Test Cases
     - Benchmarks
   - Settings

3. **Footer**
   - Status indicator
   - Version information

## Design Tokens

### Colors (Trinity Dark Mode)
The design uses OUI color variables that map to specific values in Trinity Dark mode.

### Corner Radius
Uses OUI CornerRadius variables for consistent rounded corners.

### Spacing
Uses primitive size tokens for consistent spacing throughout the UI.

## Implementation Notes

The current implementation should:
1. Use OUI color system variables
2. Support theme switching between Light and Dark modes
3. Match the M3 (Material 3) left navigation pattern
4. Include proper collapsible menu behavior
5. Maintain consistent spacing and typography

## Next Steps

To fully implement the Figma design:
1. Extract specific color values for Trinity Dark/Light themes
2. Map OUI color variables to Tailwind CSS variables
3. Implement proper spacing using the primitive size tokens
4. Ensure typography matches the design specifications
5. Add proper hover/active states for navigation items
