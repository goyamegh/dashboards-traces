# OUI Integration - First Pass

## What Was Done

Successfully integrated OpenSearch UI (OUI) components into the agent-health project as a first pass.

### Changes Made

1. **Added OUI Dependency**
   - Installed `@opensearch-project/oui@^1.23.0` with `--legacy-peer-deps` (due to React 19 vs React 16 peer dependency)
   - Added OUI light theme CSS import in `index.tsx`

2. **Created OUI Version of Agent Traces Page**
   - New file: `components/traces/AgentTracesPageOUI.tsx`
   - Converted from shadcn/Radix UI components to OUI components
   - Maintains all functionality of the original page

3. **Added Navigation**
   - New route: `/agent-traces-oui`
   - Added sidebar link: "Agent Traces (OUI)"

### Component Mapping

| Original (shadcn/Radix) | OUI Equivalent |
|------------------------|----------------|
| Card | OuiPanel |
| Button | OuiButton |
| Input | OuiFieldSearch |
| Select | OuiSelect |
| Table | OuiBasicTable |
| Badge | OuiBadge |
| Sheet (Flyout) | OuiFlyout |
| - | OuiStat (for metrics) |
| - | OuiHealth (for status) |
| - | OuiCallOut (for errors) |

### Key OUI Features Used

- **OuiPage/OuiPageBody**: Page layout structure
- **OuiPageHeader**: Consistent header with title and actions
- **OuiStat**: Metric cards with built-in loading states
- **OuiBasicTable**: Data table with sorting and row actions
- **OuiFlyout**: Side panel for trace details
- **OuiTabbedContent**: Tabbed interface in flyout
- **OuiHealth**: Status indicators (success/error)
- **OuiCallOut**: Alert/error messages
- **OuiEmptyPrompt**: Empty state with icon

### How to View

1. Navigate to http://localhost:4000
2. Click "Agent Traces (OUI)" in the sidebar
3. Or go directly to http://localhost:4000/agent-traces-oui

### Comparison

**Original Version** (`/agent-traces`):
- Modern, clean design with Tailwind CSS
- Custom shadcn/ui components
- Flexible, customizable styling

**OUI Version** (`/agent-traces-oui`):
- OpenSearch Dashboards look and feel
- Consistent with other OpenSearch products
- Built-in accessibility features
- Familiar to OpenSearch users

## Next Steps

To fully integrate OUI across the project:

1. **Convert More Pages**
   - Dashboard
   - Test Cases
   - Benchmarks
   - Settings

2. **Create OUI Theme**
   - Match OpenSearch branding
   - Custom color palette
   - Typography adjustments

3. **Add OUI-Specific Features**
   - OuiDataGrid for large datasets
   - OuiSearchBar with query DSL
   - OuiDatePicker for time ranges
   - OuiToast for notifications

4. **Optimize Bundle Size**
   - Tree-shake unused OUI components
   - Consider code splitting

5. **Resolve Peer Dependencies**
   - Evaluate React 19 compatibility
   - Consider downgrading to React 18 if needed

## Notes

- OUI CSS is loaded globally, so both versions coexist
- The original version remains unchanged at `/agent-traces`
- OUI components work well with the existing data fetching logic
- Some styling adjustments may be needed for perfect alignment
