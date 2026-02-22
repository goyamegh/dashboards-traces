/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Sample Runs for Demo Mode
 *
 * Pre-completed evaluation runs with realistic Travel Planner trajectories
 * showing multi-agent orchestration. Always visible alongside real runs -
 * IDs prefixed with 'demo-'.
 */

import type { TestCaseRun, TrajectoryStep, ToolCallStatus } from '../../types/index.js';

// Helper to generate trajectory step IDs
let stepIdCounter = 0;
function stepId(): string {
  return `demo-step-${++stepIdCounter}`;
}

function createStep(
  type: TrajectoryStep['type'],
  content: string,
  extras?: Partial<TrajectoryStep>
): TrajectoryStep {
  return {
    id: stepId(),
    timestamp: Date.now(),
    type,
    content,
    ...extras,
  };
}

export const SAMPLE_RUNS: TestCaseRun[] = [
  // Demo Report 001 - Weekend Getaway to Napa Valley
  {
    id: 'demo-report-001',
    timestamp: '2024-01-15T10:05:00.000Z',
    testCaseId: 'demo-travel-001',
    testCaseVersion: 1,
    experimentId: 'demo-bench-basic',
    experimentRunId: 'demo-run-001',
    agentName: 'ML Commons Agent',
    agentKey: 'ml-commons',
    modelName: 'Claude 3.5 Sonnet',
    modelId: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
    status: 'completed',
    passFailStatus: 'passed',
    runId: 'demo-agent-run-001',
    trajectory: [
      createStep('thinking', 'The user wants a weekend getaway to Napa Valley for two people. I need to coordinate multiple agents: Weather Agent for forecast, Events Agent for local activities, and Booking Agent for restaurant reservations. Let me start by checking the weather.'),
      createStep('action', 'Invoking Weather Agent to check Napa Valley weekend forecast', {
        toolName: 'invoke_weather_agent',
        toolArgs: { location: 'Napa Valley, CA', dates: 'this Saturday-Sunday', detail: 'hourly' },
      }),
      createStep('tool_result', 'Weather Forecast for Napa Valley:\n- Saturday: Sunny, 72F/22C, light breeze 5mph, UV index 6\n- Sunday: Partly cloudy, 68F/20C, calm winds\n- No rain expected\n- Perfect conditions for outdoor wine tasting', {
        status: 'SUCCESS' as ToolCallStatus,
      }),
      createStep('thinking', 'Weather looks perfect for outdoor activities. Now let me find local events and wine tastings for the weekend.'),
      createStep('action', 'Invoking Events Agent to find Napa Valley weekend activities', {
        toolName: 'invoke_events_agent',
        toolArgs: { location: 'Napa Valley, CA', dates: 'this Saturday-Sunday', categories: ['wine-tasting', 'food-festival', 'tours'] },
      }),
      createStep('tool_result', 'Local Events Found:\n1. Domaine Carneros - Saturday Wine & Cheese Pairing ($45/person, 11am-1pm)\n2. Oxbow Public Market - Saturday Artisan Food Market (free, 9am-5pm)\n3. Robert Mondavi Winery - Sunday Vineyard Tour & Tasting ($65/person, 10am)\n4. Napa Valley Wine Train - Saturday Sunset Dinner ($150/person, 5pm-8pm)\n5. Castello di Amorosa - Medieval Castle Winery Tour ($40/person, all day)', {
        status: 'SUCCESS' as ToolCallStatus,
      }),
      createStep('thinking', 'Great options available. Let me book a restaurant for Saturday dinner and check hotel availability.'),
      createStep('action', 'Invoking Booking Agent to reserve restaurant and check hotels', {
        toolName: 'invoke_booking_agent',
        toolArgs: { action: 'reserve', type: 'restaurant', location: 'Napa Valley', date: 'Saturday', time: '7:30 PM', party_size: 2, preferences: 'fine dining, wine pairing' },
      }),
      createStep('tool_result', 'Reservation Confirmed:\n- Restaurant: The French Laundry (alternative: Bottega Napa Valley)\n- Bottega Napa Valley: Saturday 7:30 PM, party of 2 - CONFIRMED\n- Confirmation #: BNV-2024-0892\n- Price: ~$120-150 for two (excluding wine)\n\nHotel Options:\n- Napa Valley Lodge: $289/night, pool, hot tub, vineyard views\n- Carneros Resort: $425/night, luxury cottages\n- Best Western Plus: $179/night, downtown Napa', {
        status: 'SUCCESS' as ToolCallStatus,
      }),
      createStep('response', '## Napa Valley Weekend Getaway Itinerary\n\n**Weather:** Sunny Saturday (72F), Partly cloudy Sunday (68F) - perfect for wine country!\n\n### Saturday\n- **9:00 AM** - Arrive & explore Oxbow Public Market (free)\n- **11:00 AM** - Domaine Carneros Wine & Cheese Pairing ($45/person)\n- **1:30 PM** - Lunch at Oxbow Public Market\n- **3:00 PM** - Castello di Amorosa Castle Winery Tour ($40/person)\n- **7:30 PM** - Dinner at Bottega Napa Valley (Confirmed: BNV-2024-0892)\n\n### Sunday\n- **9:00 AM** - Leisurely breakfast at hotel\n- **10:00 AM** - Robert Mondavi Vineyard Tour & Tasting ($65/person)\n- **12:30 PM** - Lunch in Yountville\n- **2:00 PM** - Drive home\n\n**Accommodation:** Napa Valley Lodge ($289/night) - vineyard views, pool\n\n**Estimated Budget:**\n- Hotel (1 night): $289\n- Wine tastings/tours: $195 per person ($390 total)\n- Dinner: ~$150\n- Lunch/snacks: ~$60\n- **Total: ~$889** (slightly over $800 budget)\n\n**Tip:** Book Domaine Carneros and Robert Mondavi online in advance for guaranteed spots.'),
    ],
    metrics: {
      accuracy: 94,
    },
    llmJudgeReasoning: 'The agent effectively coordinated all three specialist agents (Weather, Events, Booking) to produce a comprehensive weekend itinerary. Weather was checked first to ensure outdoor activities were viable. Restaurant reservation was confirmed with a booking reference. The budget was close to the $800 target with a clear breakdown.',
    improvementStrategies: [
      {
        category: 'Budget Optimization',
        issue: 'Total slightly exceeds the $800 budget target',
        recommendation: 'Could suggest the more affordable Best Western option or skip one wine tasting to stay within budget',
        priority: 'low',
      },
    ],
  },

  // Demo Report 002 - Japan Cherry Blossom Season Trip
  {
    id: 'demo-report-002',
    timestamp: '2024-01-15T10:10:00.000Z',
    testCaseId: 'demo-travel-002',
    testCaseVersion: 1,
    experimentId: 'demo-bench-basic',
    experimentRunId: 'demo-run-001',
    agentName: 'ML Commons Agent',
    agentKey: 'ml-commons',
    modelName: 'Claude 3.5 Sonnet',
    modelId: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
    status: 'completed',
    passFailStatus: 'passed',
    runId: 'demo-agent-run-002',
    trajectory: [
      createStep('thinking', 'This is a complex 10-day international trip to Japan covering three cities during cherry blossom season. I need to coordinate flights, hotels, rail passes, cultural events, and weather forecasts across Tokyo, Kyoto, and Osaka. Let me start with flights and cherry blossom timing.'),
      createStep('action', 'Invoking Booking Agent to search international flights', {
        toolName: 'invoke_booking_agent',
        toolArgs: { action: 'search_flights', origin: 'SFO', destinations: ['NRT', 'KIX'], dates: { depart: 'March 25', return: 'April 4' }, passengers: 2, class: 'economy' },
      }),
      createStep('tool_result', 'Flight Options:\n1. ANA NH7 SFO->NRT Mar 25 (dep 11:30, arr Mar 26 15:30) - $850/person\n   Return: ANA NH6 KIX->SFO Apr 4 (dep 17:00, arr Apr 4 10:30) - included\n2. JAL JL1 SFO->HND Mar 25 (dep 13:00, arr Mar 26 17:00) - $920/person\n3. United UA837 SFO->NRT Mar 25 (dep 14:15, arr Mar 26 18:15) - $780/person\n\nRecommended: ANA open-jaw (SFO->NRT, KIX->SFO) $850/person - no backtrack', {
        status: 'SUCCESS' as ToolCallStatus,
      }),
      createStep('action', 'Invoking Weather Agent for cherry blossom forecast across three cities', {
        toolName: 'invoke_weather_agent',
        toolArgs: { locations: ['Tokyo', 'Kyoto', 'Osaka'], dates: 'March 25 - April 4', forecast_type: 'cherry_blossom' },
      }),
      createStep('tool_result', 'Cherry Blossom Forecast 2024:\n- Tokyo: Full bloom March 26-31, petals falling April 1-5\n- Kyoto: Full bloom March 30 - April 4, peak April 1-2\n- Osaka: Full bloom March 29 - April 3\n\nWeather:\n- Tokyo (Mar 25-29): 58-64F, partly cloudy, 20% rain chance\n- Kyoto (Mar 30-Apr 1): 60-66F, sunny, ideal viewing\n- Osaka (Apr 2-4): 62-68F, partly cloudy\n\nRecommendation: Current itinerary timing is excellent for all three cities', {
        status: 'SUCCESS' as ToolCallStatus,
      }),
      createStep('action', 'Invoking Events Agent to find cultural events and activities', {
        toolName: 'invoke_events_agent',
        toolArgs: { locations: ['Tokyo', 'Kyoto', 'Osaka'], dates: 'March 25 - April 4', categories: ['cherry-blossom', 'tea-ceremony', 'temple', 'cultural'] },
      }),
      createStep('tool_result', 'Cultural Events Found:\n\nTokyo (Mar 26-29):\n- Ueno Park Hanami Festival (free, all day, peak bloom)\n- Chidorigafuchi Night Cherry Blossoms (illuminated, 6-10pm, free)\n- Meiji Shrine Spring Grand Festival (Mar 28)\n- Yanaka District Walking Tour ($25/person, 3 hours)\n\nKyoto (Mar 30-Apr 1):\n- Philosopher\'s Path Sakura Walk (free, peak bloom)\n- Kiyomizu-dera Night Illumination ($4/person, 6-9pm)\n- Tea Ceremony at Camellia Garden ($55/person, 2pm, reservation needed)\n- Fushimi Inari Shrine (free, best at sunrise)\n\nOsaka (Apr 2-4):\n- Osaka Castle Cherry Blossom Festival (free grounds, castle $6)\n- Dotonbori Night Food Tour ($45/person, 6-9pm)\n- Sumiyoshi Taisha Spring Festival (Apr 3)', {
        status: 'SUCCESS' as ToolCallStatus,
      }),
      createStep('action', 'Invoking Booking Agent for hotels including ryokan in Kyoto', {
        toolName: 'invoke_booking_agent',
        toolArgs: { action: 'book_hotels', itinerary: [
          { city: 'Tokyo', checkin: 'Mar 26', checkout: 'Mar 30', guests: 2 },
          { city: 'Kyoto', checkin: 'Mar 30', checkout: 'Apr 2', type: 'ryokan', guests: 2 },
          { city: 'Osaka', checkin: 'Apr 2', checkout: 'Apr 4', guests: 2 },
        ]},
      }),
      createStep('tool_result', 'Hotel Bookings:\n\n1. Tokyo - Hotel Gracery Shinjuku (4 nights)\n   - $145/night, Shinjuku location, Godzilla view!\n   - Confirmation: TKY-2024-3847\n\n2. Kyoto - Gion Hatanaka Ryokan (2 nights)\n   - $280/night, traditional kaiseki dinner included\n   - Onsen bath, yukata provided\n   - Confirmation: KYO-2024-1923\n\n3. Osaka - Cross Hotel Osaka (2 nights)\n   - $120/night, Shinsaibashi location\n   - Near Dotonbori food street\n   - Confirmation: OSA-2024-5561\n\nJapan Rail Pass: 7-day JR Pass $275/person (covers Tokyo-Kyoto-Osaka shinkansen)', {
        status: 'SUCCESS' as ToolCallStatus,
      }),
      createStep('response', '## 10-Day Japan Cherry Blossom Trip Itinerary\n\n**Flights:** ANA open-jaw SFO->NRT, KIX->SFO ($850/person)\n**Rail:** 7-day JR Pass ($275/person) covers all shinkansen rides\n\n### Tokyo (Mar 26-29, 4 nights)\n- **Day 1 (Mar 26):** Arrive NRT 3:30pm, check into Hotel Gracery Shinjuku, explore Shinjuku\n- **Day 2 (Mar 27):** Ueno Park Hanami, Senso-ji Temple, Chidorigafuchi Night Sakura\n- **Day 3 (Mar 28):** Meiji Shrine Festival, Harajuku, Shibuya Crossing, Yanaka Walk\n- **Day 4 (Mar 29):** Tsukiji Outer Market, TeamLab Borderless, Akihabara\n\n### Kyoto (Mar 30 - Apr 1, 2 nights at Gion Hatanaka Ryokan)\n- **Day 5 (Mar 30):** Shinkansen to Kyoto (2h15m), Philosopher\'s Path, Kiyomizu-dera Night Illumination\n- **Day 6 (Mar 31):** Fushimi Inari (sunrise), Arashiyama Bamboo Grove, Tea Ceremony ($55/person)\n- **Day 7 (Apr 1):** Kinkaku-ji, Nijo Castle, Gion District evening stroll\n\n### Osaka (Apr 2-4, 2 nights)\n- **Day 8 (Apr 2):** Train to Osaka, Osaka Castle Cherry Blossoms, Shinsekai district\n- **Day 9 (Apr 3):** Sumiyoshi Taisha Festival, Dotonbori Food Tour ($45/person)\n- **Day 10 (Apr 4):** Morning at Kuromon Market, depart KIX 5pm\n\n**Budget per person:**\n- Flights: $850\n- Hotels: $1,090 (split: $545/person)\n- JR Pass: $275\n- Activities: ~$200\n- Food: ~$500 (10 days)\n- **Total: ~$2,370/person** (well within $5,000 budget)'),
    ],
    metrics: {
      accuracy: 91,
    },
    llmJudgeReasoning: 'Excellent multi-agent coordination for a complex international trip. The agent correctly sequenced flights first, then cherry blossom timing, cultural events, and finally hotels. The open-jaw flight recommendation shows good logistics thinking. Ryokan booking in Kyoto as requested. Day-by-day itinerary is well-structured and the budget is clearly broken down.',
    improvementStrategies: [
      {
        category: 'Completeness',
        issue: 'Missing pocket WiFi / SIM card recommendation mentioned in context',
        recommendation: 'Add a practical logistics section covering WiFi, IC cards (Suica/ICOCA), and useful apps',
        priority: 'medium',
      },
    ],
  },

  // Demo Report 003 - Budget Southeast Asia Adventure
  {
    id: 'demo-report-003',
    timestamp: '2024-01-15T10:15:00.000Z',
    testCaseId: 'demo-travel-003',
    testCaseVersion: 1,
    experimentId: 'demo-bench-basic',
    experimentRunId: 'demo-run-001',
    agentName: 'ML Commons Agent',
    agentKey: 'ml-commons',
    modelName: 'Claude 3.5 Sonnet',
    modelId: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
    status: 'completed',
    passFailStatus: 'passed',
    runId: 'demo-agent-run-003',
    trajectory: [
      createStep('thinking', 'Budget-constrained trip under $1500 to Southeast Asia. I need the Budget Agent to compare destinations first, then find cheap flights and accommodations. The key constraint is the total budget.'),
      createStep('action', 'Invoking Budget Agent to compare Southeast Asia destinations', {
        toolName: 'invoke_budget_agent',
        toolArgs: { destinations: ['Bangkok, Thailand', 'Hanoi, Vietnam', 'Siem Reap, Cambodia'], duration: 5, budget: 1500, departure: 'LAX' },
      }),
      createStep('tool_result', 'Budget Comparison (5 days, from LAX):\n\n| Category | Thailand | Vietnam | Cambodia |\n|----------|----------|---------|----------|\n| Flights  | $520     | $580    | $640     |\n| Hotels   | $25/night| $18/night| $15/night|\n| Food     | $12/day  | $8/day  | $7/day   |\n| Activities| $150    | $120    | $100     |\n| **Total**| **$915** | **$878**| **$895** |\n\nRecommendation: Vietnam offers best value with rich cultural experiences.\nThailand is close second with better beaches.\n\nBest option for beaches + temples + street food: Thailand (Phuket + Bangkok split)', {
        status: 'SUCCESS' as ToolCallStatus,
      }),
      createStep('thinking', 'Vietnam offers the best value, but Thailand better matches the beach + temple + street food criteria. Let me search for budget flights to Bangkok.'),
      createStep('action', 'Invoking Booking Agent to search budget flights', {
        toolName: 'invoke_booking_agent',
        toolArgs: { action: 'search_flights', origin: 'LAX', destination: 'BKK', dates: { depart: 'flexible', return: 'flexible+5' }, passengers: 1, class: 'economy', max_price: 600 },
      }),
      createStep('tool_result', 'Budget Flight Options LAX -> BKK:\n1. China Southern via CAN: $485 round-trip (1 stop, 22h total)\n2. EVA Air via TPE: $520 round-trip (1 stop, 18h total)\n3. Korean Air via ICN: $545 round-trip (1 stop, 19h total)\n\nNote: Domestic BKK->HKT (Phuket) one-way: $35 on AirAsia\n\nRecommended: China Southern $485 + AirAsia $35 = $520 total flights', {
        status: 'SUCCESS' as ToolCallStatus,
      }),
      createStep('action', 'Invoking Events Agent to find free and cheap activities', {
        toolName: 'invoke_events_agent',
        toolArgs: { locations: ['Bangkok', 'Phuket'], dates: 'flexible 5 days', categories: ['temple', 'beach', 'market', 'street-food'], price_range: 'free-cheap' },
      }),
      createStep('tool_result', 'Free & Budget Activities:\n\nBangkok (Days 1-2):\n- Grand Palace & Wat Phra Kaew ($16 entrance)\n- Wat Pho / Reclining Buddha ($3.50)\n- Chatuchak Weekend Market (free)\n- Chinatown Yaowarat Street Food Walk (free, food ~$3-5/meal)\n- Khao San Road nightlife (free to walk)\n\nPhuket (Days 3-5):\n- Kata Beach / Karon Beach (free)\n- Big Buddha viewpoint (free, donation appreciated)\n- Old Phuket Town walking tour (free)\n- Phuket Night Market (free, food $2-4)\n- Phi Phi Island Day Trip ($45 including lunch)\n\nTotal Activities Budget: ~$75', {
        status: 'SUCCESS' as ToolCallStatus,
      }),
      createStep('response', '## Budget Thailand Adventure - 5 Days Under $1,500\n\n### Flights ($520)\n- LAX -> BKK: China Southern via CAN ($485 round-trip)\n- BKK -> HKT: AirAsia domestic ($35 one-way)\n\n### Accommodation ($125)\n- Bangkok: NapPark Hostel, Khao San ($25/night x 2 = $50)\n- Phuket: Lub d Phuket Patong ($25/night x 3 = $75)\n\n### Itinerary\n**Day 1 - Bangkok:** Arrive, Khao San Road, Chinatown street food tour\n**Day 2 - Bangkok:** Grand Palace ($16), Wat Pho ($3.50), Chatuchak Market, night tuk-tuk ride\n**Day 3 - Phuket:** Fly BKK->HKT, afternoon at Kata Beach, Old Town sunset\n**Day 4 - Phuket:** Phi Phi Island Day Trip ($45), evening at Phuket Night Market\n**Day 5 - Phuket:** Big Buddha viewpoint, beach morning, fly HKT->BKK, depart\n\n### Budget Breakdown\n| Category | Cost |\n|----------|------|\n| Flights | $520 |\n| Accommodation | $125 |\n| Food (5 days @ $12/day) | $60 |\n| Activities | $75 |\n| Local transport | $40 |\n| Emergency buffer | $100 |\n| **Total** | **$920** |\n\n**$580 under budget!** Consider upgrading to a private room or adding a cooking class ($30).'),
    ],
    metrics: {
      accuracy: 88,
    },
    llmJudgeReasoning: 'The agent effectively used the Budget Agent for destination comparison and maintained strict budget discipline throughout. The itinerary includes the requested beaches, temples, and street food. Budget breakdown is clear and comes in well under the $1500 limit.',
    improvementStrategies: [
      {
        category: 'Analysis Depth',
        issue: 'Could have explored Vietnam as a potentially better cultural experience',
        recommendation: 'Present top 2 destination options with pros/cons rather than deciding for the user',
        priority: 'medium',
      },
    ],
  },

  // Demo Report 003b - Budget Southeast Asia (for advanced benchmark)
  {
    id: 'demo-report-003b',
    timestamp: '2024-01-15T11:05:00.000Z',
    testCaseId: 'demo-travel-003',
    testCaseVersion: 1,
    experimentId: 'demo-bench-advanced',
    experimentRunId: 'demo-run-002',
    agentName: 'ML Commons Agent',
    agentKey: 'ml-commons',
    modelName: 'Claude 3.5 Sonnet',
    modelId: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
    status: 'completed',
    passFailStatus: 'passed',
    runId: 'demo-agent-run-003b',
    trajectory: [
      createStep('thinking', 'Budget trip under $1500 to Southeast Asia. Need to invoke Budget Agent for cost comparison, then Booking Agent for flights, and Events Agent for activities.'),
      createStep('action', 'Invoking Budget Agent for destination cost analysis', {
        toolName: 'invoke_budget_agent',
        toolArgs: { destinations: ['Thailand', 'Vietnam', 'Cambodia'], budget: 1500, duration: 5 },
      }),
      createStep('tool_result', 'Destination Analysis:\n- Thailand: $915 estimated (best beaches)\n- Vietnam: $878 estimated (best value)\n- Cambodia: $895 estimated (best temples)\n\nRecommendation: Vietnam for maximum budget savings with excellent culture', {
        status: 'SUCCESS' as ToolCallStatus,
      }),
      createStep('action', 'Searching budget flights to Ho Chi Minh City', {
        toolName: 'search_flights',
        toolArgs: { origin: 'LAX', destination: 'SGN', budget_max: 600 },
      }),
      createStep('tool_result', 'Best flights:\n1. Vietnam Airlines via NRT: $545 round-trip\n2. Korean Air via ICN: $560 round-trip\n3. Cathay Pacific via HKG: $580 round-trip', {
        status: 'SUCCESS' as ToolCallStatus,
      }),
      createStep('response', '## Vietnam Budget Adventure - 5 Days for $878\n\nOptimized itinerary covering Ho Chi Minh City and Mekong Delta.\nFlights: $545, Accommodation: $90, Food: $40, Activities: $120, Transport: $30, Buffer: $53\n**Total: $878 - saving $622 from budget!**'),
    ],
    metrics: {
      accuracy: 85,
    },
    llmJudgeReasoning: 'The agent chose Vietnam for budget optimization. The cost analysis was thorough but the final itinerary was less detailed than expected. Missing beach component that was requested.',
    improvementStrategies: [
      {
        category: 'Completeness',
        issue: 'Beach activities not adequately covered for Vietnam selection',
        recommendation: 'Include Da Nang or Phu Quoc for beach component, or reconsider Thailand',
        priority: 'high',
      },
    ],
  },

  // Demo Report 004 - Team Building Retreat in Colorado
  {
    id: 'demo-report-004',
    timestamp: '2024-01-15T11:10:00.000Z',
    testCaseId: 'demo-travel-004',
    testCaseVersion: 1,
    experimentId: 'demo-bench-advanced',
    experimentRunId: 'demo-run-002',
    agentName: 'ML Commons Agent',
    agentKey: 'ml-commons',
    modelName: 'Claude 3.5 Sonnet',
    modelId: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
    status: 'completed',
    passFailStatus: 'passed',
    runId: 'demo-agent-run-004',
    trajectory: [
      createStep('thinking', 'Complex group logistics: 12 people, dietary restrictions, mixed fitness levels, need meeting space. I should check weather first for outdoor activity safety, then find accommodation with meeting space, book activities, and arrange catering.'),
      createStep('action', 'Invoking Weather Agent for Colorado mountain forecast', {
        toolName: 'invoke_weather_agent',
        toolArgs: { location: 'Estes Park, Colorado', dates: 'Thursday-Sunday this week', detail: 'outdoor_safety' },
      }),
      createStep('tool_result', 'Colorado Mountain Forecast (Estes Park area):\n- Thursday PM: 55F, clear skies, wind 10mph\n- Friday: 52-62F, sunny, perfect hiking weather\n- Saturday: 48-58F, partly cloudy, 15% rain chance afternoon\n- Sunday AM: 45F, clear\n\nOutdoor Safety: Green flag for all activities\n- UV Index: 7-8 (high altitude, sunscreen essential)\n- River levels: Normal, rafting safe\n- Trail conditions: Dry, well-maintained', {
        status: 'SUCCESS' as ToolCallStatus,
      }),
      createStep('action', 'Invoking Booking Agent for group lodge with meeting space', {
        toolName: 'invoke_booking_agent',
        toolArgs: { action: 'search_group_accommodation', location: 'Estes Park, CO', guests: 12, nights: 3, requirements: ['meeting_room', 'kitchen', 'wifi', 'parking'] },
      }),
      createStep('tool_result', 'Group Accommodation Options:\n\n1. YMCA of the Rockies - Estes Park\n   - 3 adjacent cabins (4 beds each) - $180/cabin/night x 3 = $1,620 total\n   - Conference room included (seats 20, projector, whiteboard)\n   - Dining hall option: $35/person/meal\n   - WiFi throughout campus\n   - Activities on-site: hiking trails, horseback riding\n   - Confirmation available\n\n2. Rocky Mountain Lodge\n   - 12-person lodge - $650/night = $1,950 total\n   - Living room converts to meeting space\n   - Full kitchen\n   - Hot tub, fire pit, mountain views\n\n3. Della Terra Mountain Chateau\n   - 14-person capacity - $850/night = $2,550 total\n   - Dedicated conference room\n   - Chef available ($75/person/day for all meals)\n   - Premium location\n\nRecommended: Option 1 for budget, Option 2 for team bonding', {
        status: 'SUCCESS' as ToolCallStatus,
      }),
      createStep('action', 'Invoking Events Agent for team building activities', {
        toolName: 'invoke_events_agent',
        toolArgs: { location: 'Estes Park, CO', group_size: 12, fitness_mixed: true, categories: ['hiking', 'rafting', 'team-building', 'evening'] },
      }),
      createStep('tool_result', 'Team Building Activities:\n\nFriday:\n- Morning: Guided Rocky Mountain Hike (2 difficulty levels)\n  - Group A (moderate): Bear Lake Trail, 3.5mi, $30/person\n  - Group B (easy): Sprague Lake Loop, 1mi, $20/person\n- Afternoon: Whitewater Rafting, Cache La Poudre River\n  - Class II-III rapids, beginner-friendly, $65/person\n  - All equipment provided, guide included\n\nSaturday:\n- Morning: Team Strategy Session (conference room)\n- Afternoon: Challenge Course & Zipline\n  - Aerial Adventure Park, $55/person\n  - Multiple difficulty levels available\n- Evening: Guided Stargazing Tour\n  - Dark Sky Preserve, $25/person\n  - Hot chocolate and blankets provided\n\nFire pit available nightly at lodge', {
        status: 'SUCCESS' as ToolCallStatus,
      }),
      createStep('thinking', 'Now I need to handle the dietary restrictions for group dining. This is critical - 3 vegetarians, 1 vegan, 1 gluten-free, 1 nut allergy.'),
      createStep('action', 'Invoking Booking Agent for group catering with dietary accommodations', {
        toolName: 'invoke_booking_agent',
        toolArgs: { action: 'arrange_catering', location: 'Estes Park, CO', group_size: 12, meals: 8, dietary: { vegetarian: 3, vegan: 1, gluten_free: 1, nut_allergy: 1 } },
      }),
      createStep('tool_result', 'Catering Arranged:\n\nProvider: Mountain Fresh Catering (Estes Park)\n- Specializes in group retreats with dietary accommodations\n- All meals labeled with allergen information\n- Separate prep area for allergen-free items\n\nMenu Plan:\n- Thursday dinner: BBQ with veggie burgers, GF buns, nut-free sides\n- Friday breakfast: Buffet with vegan options, GF pancakes\n- Friday lunch: Trail box lunches (dietary-specific labels)\n- Friday dinner: Build-your-own tacos (naturally accommodates all diets)\n- Saturday meals: Italian theme with GF pasta, vegan sauce options\n- Sunday breakfast: Continental + hot options\n\nCost: $40/person/meal x 8 meals = $3,840 total\nDietary confirmation #: MFC-2024-ESTES-0447', {
        status: 'SUCCESS' as ToolCallStatus,
      }),
      createStep('response', '## Colorado Team Building Retreat - 12 People, 3 Days\n\n**Accommodation:** Rocky Mountain Lodge ($650/night x 3 = $1,950)\n- Sleeps 12, hot tub, fire pit, mountain views\n- Meeting space with WiFi\n\n### Schedule\n\n**Thursday:**\n- 3:00 PM - Arrive, settle in\n- 5:00 PM - Welcome gathering, lodge tour\n- 7:00 PM - BBQ dinner (dietary accommodations confirmed)\n- 9:00 PM - Campfire & team introductions\n\n**Friday:**\n- 8:00 AM - Breakfast buffet\n- 9:30 AM - Guided Hikes (two groups by fitness level)\n- 12:30 PM - Trail lunch\n- 2:00 PM - Whitewater Rafting ($65/person)\n- 6:30 PM - Taco dinner\n- 8:30 PM - Campfire & s\'mores\n\n**Saturday:**\n- 8:00 AM - Breakfast\n- 9:30 AM - Strategy Session (2 hours, meeting room)\n- 12:00 PM - Lunch\n- 1:30 PM - Aerial Adventure Park ($55/person)\n- 6:30 PM - Italian dinner\n- 8:30 PM - Guided Stargazing Tour ($25/person)\n\n**Sunday:**\n- 8:00 AM - Breakfast\n- 10:00 AM - Check out, depart\n\n### Budget per Person ($1,200 target)\n| Category | Per Person |\n|----------|------------|\n| Accommodation | $163 |\n| Flights AUS->DEN | $250 |\n| Ground transport | $50 |\n| Catering (8 meals) | $320 |\n| Activities | $175 |\n| Misc | $42 |\n| **Total** | **$1,000** |\n\n**Dietary Accommodations:** All meals labeled, allergen-free prep confirmed (MFC-2024-ESTES-0447)\n**$200 under budget per person ($2,400 total savings)**'),
    ],
    metrics: {
      accuracy: 92,
    },
    llmJudgeReasoning: 'Excellent handling of group logistics complexity. The agent addressed all requirements: weather safety check, mixed fitness levels with two hiking groups, dietary accommodations with specific caterer confirmation, meeting space, and evening activities. Budget came in under target with clear per-person breakdown.',
    improvementStrategies: [
      {
        category: 'Risk Planning',
        issue: 'No contingency plan for bad weather on outdoor days',
        recommendation: 'Include indoor backup activities in case of unexpected weather changes',
        priority: 'medium',
      },
    ],
  },

  // Demo Report 005 - Last-Minute Holiday Deal
  {
    id: 'demo-report-005',
    timestamp: '2024-01-15T11:15:00.000Z',
    testCaseId: 'demo-travel-005',
    testCaseVersion: 1,
    experimentId: 'demo-bench-advanced',
    experimentRunId: 'demo-run-002',
    agentName: 'ML Commons Agent',
    agentKey: 'ml-commons',
    modelName: 'Claude 3.5 Sonnet',
    modelId: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
    status: 'completed',
    passFailStatus: 'failed',
    runId: 'demo-agent-run-005',
    trajectory: [
      createStep('thinking', 'Time-pressured booking for next weekend. I need to quickly search last-minute deals, verify weather at candidate destinations, and check availability. Speed is critical since deals can sell out.'),
      createStep('action', 'Invoking Booking Agent to search last-minute beach deals from MIA', {
        toolName: 'invoke_booking_agent',
        toolArgs: { action: 'search_last_minute', origin: 'MIA', dates: { depart: 'Friday PM', return: 'Sunday PM' }, type: 'beach_package', max_price: 1000 },
      }),
      createStep('tool_result', 'Last-Minute Deals from MIA (this weekend):\n\n1. Cancun, Mexico - All-Inclusive\n   - Flight + Hotel: $689/person\n   - Hyatt Ziva Cancun, ocean view\n   - All meals and drinks included\n   - Status: 3 rooms left!\n\n2. Nassau, Bahamas - Beach Resort\n   - Flight + Hotel: $725/person\n   - Atlantis Paradise Island\n   - Breakfast included\n   - Status: Available\n\n3. Key West, FL - Boutique Hotel\n   - No flight needed (drive 3.5h)\n   - Hotel: $420 for 2 nights\n   - The Marker Waterfront Inn\n   - Status: Last room!\n\n4. Turks & Caicos - Beach Villa\n   - Flight + Hotel: $950/person\n   - Grace Bay Club\n   - Status: SOLD OUT while searching', {
        status: 'SUCCESS' as ToolCallStatus,
      }),
      createStep('thinking', 'Turks & Caicos already sold out - need to move fast. Let me verify weather at the remaining options and check the Cancun deal since it is the best value with all-inclusive.'),
      createStep('action', 'Invoking Weather Agent to verify warm beach weather at candidates', {
        toolName: 'invoke_weather_agent',
        toolArgs: { locations: ['Cancun, Mexico', 'Nassau, Bahamas', 'Key West, FL'], dates: 'this Friday-Sunday' },
      }),
      createStep('tool_result', 'Weekend Weather:\n- Cancun: 85F, sunny, 5% rain, water temp 79F - PERFECT\n- Nassau: 82F, partly cloudy, 20% rain Saturday PM, water temp 76F - GOOD\n- Key West: 80F, sunny, 10% rain, water temp 75F - GOOD\n\nAll destinations have warm beach weather suitable for the trip.', {
        status: 'SUCCESS' as ToolCallStatus,
      }),
      createStep('action', 'Invoking Budget Agent to validate deal pricing', {
        toolName: 'invoke_budget_agent',
        toolArgs: { deals: [
          { destination: 'Cancun', price: 689, type: 'all-inclusive' },
          { destination: 'Nassau', price: 725, type: 'breakfast-included' },
          { destination: 'Key West', price: 420, type: 'hotel-only' },
        ], validate: true },
      }),
      createStep('tool_result', 'Deal Validation:\n\n1. Cancun $689 all-inclusive: GENUINE DEAL\n   - Normal price: $1,100-1,400\n   - Savings: 38-50%\n   - Includes: flights, hotel, all meals, drinks, activities\n   - Cancellation: Free until 24h before\n\n2. Nassau $725 breakfast-only: FAIR DEAL\n   - Normal price: $900-1,100\n   - Savings: 18-34%\n   - Additional food costs: ~$100-150\n   - Total estimated: $875\n   - Cancellation: Non-refundable\n\n3. Key West $420 hotel-only: OK VALUE\n   - Normal price: $500-600\n   - Savings: 16-30%\n   - Additional costs: gas ($50), food ($150), activities ($100)\n   - Total estimated: $720\n   - Cancellation: Free until 48h before\n\nRecommendation: Cancun is the clear winner for value and convenience', {
        status: 'SUCCESS' as ToolCallStatus,
      }),
      createStep('response', '## Last-Minute Beach Deal - Book Now!\n\n### Top Recommendation: Cancun All-Inclusive ($689)\n- **Hotel:** Hyatt Ziva Cancun, ocean view room\n- **Includes:** Round-trip flights from MIA, all meals, drinks, pool, beach\n- **Weather:** 85F, sunny, perfect beach conditions\n- **Savings:** 38-50% off normal price\n- **Cancellation:** Free cancellation until 24 hours before departure\n- **HURRY: Only 3 rooms remaining!**\n\n### Backup Options\n1. Key West Drive Trip ($720 total) - Best cancellation policy\n2. Nassau Bahamas ($875 estimated total) - Good but non-refundable\n\n### Comparison\n| | Cancun | Key West | Nassau |\n|--|--------|----------|--------|\n| Total Cost | $689 | $720 | $875 |\n| All-Inclusive | Yes | No | Partial |\n| Beach Quality | Excellent | Good | Excellent |\n| Cancel Policy | Free 24h | Free 48h | Non-refund |\n| Weather | 85F sunny | 80F sunny | 82F clouds |\n\n**Action Required:** Book the Cancun deal immediately before remaining rooms sell out.'),
    ],
    metrics: {
      accuracy: 72,
    },
    llmJudgeReasoning: 'The agent demonstrated urgency awareness and good deal comparison. However, it failed to actually complete the booking as instructed - the user said "need to book everything today" but the agent only presented options without confirming a reservation. The Turks & Caicos selling out mid-search was a good real-time handling but should have triggered faster action on remaining options. Missing travel insurance recommendation.',
    improvementStrategies: [
      {
        category: 'Task Completion',
        issue: 'Did not actually complete the booking, only presented options',
        recommendation: 'When user says "book everything today," proceed to confirm reservation rather than just recommending',
        priority: 'high',
      },
      {
        category: 'Completeness',
        issue: 'Missing travel insurance recommendation mentioned in context',
        recommendation: 'Include travel insurance option especially for last-minute bookings with weather risk',
        priority: 'medium',
      },
    ],
  },
];

/**
 * Get a sample run by ID
 */
export function getSampleRun(id: string): TestCaseRun | undefined {
  return SAMPLE_RUNS.find(run => run.id === id);
}

/**
 * Get all sample runs
 */
export function getAllSampleRuns(): TestCaseRun[] {
  return [...SAMPLE_RUNS];
}

/**
 * Get sample runs by test case ID
 */
export function getSampleRunsByTestCase(testCaseId: string): TestCaseRun[] {
  return SAMPLE_RUNS.filter(run => run.testCaseId === testCaseId);
}

/**
 * Get sample runs by benchmark ID
 */
export function getSampleRunsByBenchmark(benchmarkId: string): TestCaseRun[] {
  return SAMPLE_RUNS.filter(run => run.experimentId === benchmarkId);
}

/**
 * Get sample runs by benchmark run ID
 */
export function getSampleRunsByBenchmarkRun(benchmarkId: string, benchmarkRunId: string): TestCaseRun[] {
  return SAMPLE_RUNS.filter(run => run.experimentId === benchmarkId && run.experimentRunId === benchmarkRunId);
}

// Backwards compatibility aliases
/** @deprecated Use getSampleRunsByBenchmark instead */
export const getSampleRunsByExperiment = getSampleRunsByBenchmark;
/** @deprecated Use getSampleRunsByBenchmarkRun instead */
export const getSampleRunsByExperimentRun = getSampleRunsByBenchmarkRun;

/**
 * Check if an ID is a sample run
 */
export function isSampleRunId(id: string): boolean {
  return id.startsWith('demo-report-') || id.startsWith('demo-run-');
}
