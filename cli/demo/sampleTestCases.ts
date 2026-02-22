/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Sample Test Cases for Demo Mode
 *
 * Pre-configured Travel Planner scenarios based on a multi-agent orchestration
 * architecture. These test cases demonstrate the evaluation framework's
 * capabilities without requiring external dependencies.
 *
 * Agent Architecture:
 * - Travel Coordinator (orchestrator): Routes requests to specialist agents
 * - Weather Agent: Fetches weather forecasts
 * - Events Agent: Finds local events, festivals, activities
 * - Booking Agent: Handles hotel, flight, restaurant reservations
 * - Budget Agent: Optimizes costs, finds deals
 */

export interface SampleTestCase {
  id: string;
  name: string;
  description?: string;
  initialPrompt: string;
  context: Array<{ type: string; content: string }>;
  expectedOutcomes: string[];
  labels: string[];
  tags?: string[];
}

export const SAMPLE_TEST_CASES: SampleTestCase[] = [
  {
    id: 'demo-travel-001',
    name: 'Weekend Getaway to Napa Valley',
    description: 'Plan a weekend getaway with weather, events, and restaurant reservations',
    initialPrompt: `Plan a weekend getaway to Napa Valley for two people.
We want to visit wineries, enjoy good food, and relax.
Check the weather, find local events, and book restaurants.`,
    context: [
      {
        type: 'agent_architecture',
        content: `Multi-agent Travel Planner system:
- Travel Coordinator (orchestrator) delegates to specialist sub-agents
- Weather Agent: Fetches forecasts from weather APIs
- Events Agent: Finds local events, festivals, wine tastings
- Booking Agent: Handles restaurant reservations and hotel bookings
- All agents instrumented with OpenTelemetry Gen-AI semantic conventions`
      },
      {
        type: 'user_preferences',
        content: `Traveler preferences:
- Travel dates: Next Saturday-Sunday
- Party size: 2 adults
- Interests: Wine tasting, fine dining, scenic views
- Budget: Moderate (~$800 total)
- Dietary: No restrictions`
      }
    ],
    expectedOutcomes: [
      'Invoke the Weather Agent to check weekend forecast for Napa Valley',
      'Invoke the Events Agent to find wine tastings, vineyard tours, or local festivals',
      'Invoke the Booking Agent to reserve a restaurant for dinner Saturday evening',
      'Produce a cohesive weekend itinerary with timing, locations, and reservations'
    ],
    labels: ['category:Travel-Planning', 'difficulty:Easy', 'domain:Domestic', 'type:Weekend-Trip'],
    tags: ['promoted']
  },
  {
    id: 'demo-travel-002',
    name: 'Japan Cherry Blossom Season Trip',
    description: 'Plan a complex 10-day multi-city international itinerary',
    initialPrompt: `Plan a 10-day trip to Japan during cherry blossom season.
I want to visit Tokyo, Kyoto, and Osaka. Include cultural experiences,
temple visits, and authentic cuisine. Book flights and hotels.`,
    context: [
      {
        type: 'agent_architecture',
        content: `Multi-agent Travel Planner system:
- Travel Coordinator routes to Weather, Events, and Booking agents
- Booking Agent handles international flights, hotels, and rail passes
- Events Agent searches for cherry blossom festivals, tea ceremonies, temple events
- Weather Agent provides multi-city forecasts for itinerary optimization`
      },
      {
        type: 'user_preferences',
        content: `Traveler preferences:
- Travel dates: Late March to early April (peak cherry blossom)
- Party size: 2 adults
- Interests: Cherry blossoms, temples, traditional cuisine, cultural experiences
- Budget: ~$5,000 per person (flights, hotels, activities)
- Accommodation: Mix of traditional ryokan and modern hotels`
      },
      {
        type: 'travel_constraints',
        content: `Logistics considerations:
- International flights from San Francisco (SFO)
- Japan Rail Pass for inter-city travel
- Tokyo (4 nights) -> Kyoto (3 nights) -> Osaka (2 nights)
- Need pocket WiFi or SIM card recommendation
- Visa not required for US citizens (90-day tourist waiver)`
      }
    ],
    expectedOutcomes: [
      'Search for round-trip flights SFO to Tokyo (NRT/HND) with return from Osaka (KIX)',
      'Check cherry blossom forecast across Tokyo, Kyoto, and Osaka for optimal timing',
      'Find cultural events: hanami parties, tea ceremonies, temple illuminations',
      'Book hotels including at least one traditional ryokan in Kyoto',
      'Produce a day-by-day itinerary with transport, accommodations, and activities'
    ],
    labels: ['category:Travel-Planning', 'difficulty:Hard', 'domain:International', 'type:Multi-City'],
    tags: ['promoted']
  },
  {
    id: 'demo-travel-003',
    name: 'Budget Southeast Asia Adventure',
    description: 'Plan a budget-friendly 5-day trip under $1500',
    initialPrompt: `Plan a budget-friendly 5-day trip to Southeast Asia for under $1500 total.
I'm flexible on destination but want beaches, street food, and temples.
Optimize for the best experience at the lowest cost.`,
    context: [
      {
        type: 'agent_architecture',
        content: `Multi-agent Travel Planner system:
- Travel Coordinator uses Budget Agent as primary advisor
- Budget Agent: Compares costs across destinations, finds deals
- Booking Agent: Searches budget airlines, hostels, guesthouses
- Events Agent: Finds free/cheap activities, walking tours, markets`
      },
      {
        type: 'user_preferences',
        content: `Traveler preferences:
- Total budget: $1,500 maximum (flights, accommodation, food, activities)
- Duration: 5 days
- Solo traveler
- Interests: Beaches, temples, street food, local culture
- Accommodation: Budget-friendly (hostels, guesthouses OK)
- Flexible on exact destination within Southeast Asia`
      },
      {
        type: 'budget_constraints',
        content: `Cost optimization targets:
- Flights: Under $600 round-trip
- Accommodation: Under $30/night
- Food: Under $15/day (street food preferred)
- Activities: Under $200 total
- Emergency fund: $100 buffer
- Departing from Los Angeles (LAX)`
      }
    ],
    expectedOutcomes: [
      'Invoke Budget Agent to compare costs across Thailand, Vietnam, and Cambodia',
      'Search for budget flights from LAX to selected destination under $600',
      'Find accommodations under $30/night with good reviews',
      'Produce a detailed budget breakdown showing total under $1500',
      'Include free or low-cost activities: temples, beaches, markets'
    ],
    labels: ['category:Travel-Planning', 'difficulty:Medium', 'domain:International', 'type:Budget'],
    tags: ['promoted']
  },
  {
    id: 'demo-travel-004',
    name: 'Team Building Retreat in Colorado',
    description: 'Plan a group retreat for 12 people with activities and dietary requirements',
    initialPrompt: `Plan a 3-day team building retreat in Colorado for 12 people.
We need outdoor activities, meeting space, group dining, and
accommodation that keeps everyone together. Several team members
have dietary restrictions.`,
    context: [
      {
        type: 'agent_architecture',
        content: `Multi-agent Travel Planner system:
- Travel Coordinator manages complex group logistics
- Booking Agent: Group rates for lodges, conference rooms
- Events Agent: Team building activities, guided hikes, rafting
- Weather Agent: Outdoor activity safety and planning`
      },
      {
        type: 'group_details',
        content: `Group information:
- 12 people from engineering team
- 3 vegetarians, 1 vegan, 1 gluten-free, 1 nut allergy
- Mix of fitness levels (some prefer gentle hikes, others want challenging trails)
- Need WiFi for one 2-hour strategy session
- Ages range from 25 to 55
- Flying from Austin, TX (AUS)`
      },
      {
        type: 'retreat_requirements',
        content: `Retreat specifications:
- Duration: Thursday afternoon to Sunday morning (3 nights)
- Activities: Mix of adventure (rafting, hiking) and relaxed (campfire, stargazing)
- Accommodation: Lodge or cabin that fits all 12 (or adjacent units)
- Meeting space: Room for 12 with projector/screen
- Group dining: All meals together, accommodating dietary needs
- Budget: $1,200 per person ($14,400 total)`
      }
    ],
    expectedOutcomes: [
      'Check weather forecast for Colorado mountain areas for safe outdoor planning',
      'Find lodge or cabin accommodations for 12 with meeting space',
      'Book team activities: guided hike, rafting trip, and evening entertainment',
      'Arrange group dining with dietary accommodation for all restrictions',
      'Produce a group itinerary with logistics for all 12 participants'
    ],
    labels: ['category:Travel-Planning', 'difficulty:Hard', 'domain:Domestic', 'type:Group'],
    tags: ['promoted']
  },
  {
    id: 'demo-travel-005',
    name: 'Last-Minute Holiday Deal',
    description: 'Find a last-minute holiday deal for next weekend under time pressure',
    initialPrompt: `Find me a last-minute holiday deal for next weekend. I'm flexible on
destination but want somewhere warm with a beach. Need to book
everything today since deals are going fast. Budget is $1000.`,
    context: [
      {
        type: 'agent_architecture',
        content: `Multi-agent Travel Planner system:
- Travel Coordinator operates under time pressure
- Booking Agent: Searches last-minute deals, flash sales
- Budget Agent: Validates deals are genuine savings
- Weather Agent: Confirms warm beach weather at candidates
- Events Agent: Quick check for any destination warnings/closures`
      },
      {
        type: 'user_preferences',
        content: `Traveler preferences:
- Travel: This Friday evening to Sunday night
- Budget: $1,000 maximum all-inclusive
- Requirements: Warm weather, beach access
- Solo traveler, departing from Miami (MIA)
- Open to: Caribbean islands, Mexico, Florida Keys
- Needs: Flight + hotel package deals`
      },
      {
        type: 'time_constraints',
        content: `Urgency factors:
- Booking must happen within the hour
- Last-minute deals change rapidly
- Need fallback options if first choice sells out
- Cancellation policy important (weather risk)
- Travel insurance recommendation needed`
      }
    ],
    expectedOutcomes: [
      'Search multiple last-minute deal sources for beach destinations from MIA',
      'Verify weather is warm and sunny at candidate destinations',
      'Check availability in real-time and handle sold-out scenarios with fallbacks',
      'Compare at least 3 deal options with price breakdowns under $1000',
      'Present a bookable itinerary with cancellation policy details'
    ],
    labels: ['category:Travel-Planning', 'difficulty:Medium', 'domain:Domestic', 'type:Last-Minute'],
    tags: ['promoted']
  }
];

/**
 * Get a sample test case by ID
 */
export function getSampleTestCase(id: string): SampleTestCase | undefined {
  return SAMPLE_TEST_CASES.find(tc => tc.id === id);
}

/**
 * Get all sample test cases
 */
export function getAllSampleTestCases(): SampleTestCase[] {
  return [...SAMPLE_TEST_CASES];
}
