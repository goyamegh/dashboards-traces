/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Judge-reasoning first sentences modeled on the production "418-verify"
 * benchmark run (84 test cases, internal-retrieval-agent agent vs an OpenSearch-backed RAG
 * corpus). 64 of 84 cases failed; 57 fail because the OpenSearch MCP server
 * was unreachable during the run (many independent judge paraphrases of the
 * same underlying tool-connectivity failure — verbatim first sentences from
 * the real run's llmJudgeReasoning field; the connectivity-failure wording
 * carries no proprietary content), and 7 fail for a genuinely different
 * reason (missing required facts in an answer the agent DID produce —
 * reworded here with placeholder fact labels instead of the real run's
 * business content). Used to validate clusterFailureThemes() collapses the
 * 57 connectivity paraphrases into ONE theme while keeping the 7
 * required-facts failures separate — see lib/runInsights.ts.
 */

export interface MCPFixtureItem { testCaseId: string; reasoning: string; }

export const MCP_CONNECTIVITY_FIXTURE: MCPFixtureItem[] = [
  { testCaseId: 'tc-1786588512353-yni5gui3h', reasoning: 'The agent was unable to retrieve any information from the OpenSearch index due to tool connectivity issues.' },
  { testCaseId: 'tc-1786588527433-j390s8nbk', reasoning: 'The agent was unable to retrieve any information from the corpus due to OpenSearch MCP tool unavailability.' },
  { testCaseId: 'tc-1786588492232-q5zfr0zvj', reasoning: 'The agent failed to retrieve any information from the corpus due to tool connectivity issues, resulting in none of the required facts being stated:.' },
  { testCaseId: 'tc-1786588483371-molusockd', reasoning: 'The agent failed to retrieve the required information due to tool connectivity issues, and therefore could not state either required fact: (1) that the certification is valid for 18 months, and (2) that the source document is dsid_46a4cb87db414e769f2df86f01626948.' },
  { testCaseId: 'tc-1786588516368-jfhjdpoim', reasoning: 'The agent was unable to retrieve any information from the corpus because the OpenSearch MCP server had not finished connecting.' },
  { testCaseId: 'tc-1786588539508-f0xdnrpv4', reasoning: 'The agent was unable to retrieve any information from the corpus due to the OpenSearch MCP server failing to connect.' },
  { testCaseId: 'tc-1786588528436-hyxc7xpsp', reasoning: 'The agent failed to retrieve any information from the corpus because the OpenSearch MCP server tools were not available in the session.' },
  { testCaseId: 'tc-1786588502275-l98fqy8o4', reasoning: 'The agent failed to retrieve any information from the corpus due to tool connectivity issues, and therefore provided none of the required facts.' },
  { testCaseId: 'tc-1786588491229-wjttqix81', reasoning: 'The agent failed to retrieve the required information entirely.' },
  { testCaseId: 'tc-1786588520404-v5peiwbfx', reasoning: 'The agent failed to retrieve any documents from the corpus due to OpenSearch MCP server connectivity issues, and therefore could not answer any of the 21 required facts.' },
  { testCaseId: 'tc-1786588490225-hpsnx9484', reasoning: 'The agent failed to retrieve any information from the corpus due to the OpenSearch MCP server not connecting.' },
  { testCaseId: 'tc-1786588503300-5bg9ctk4v', reasoning: 'The agent failed to retrieve any information from the corpus because the OpenSearch MCP server tools were not accessible during the session.' },
  { testCaseId: 'tc-1786588542544-73kusjfy9', reasoning: 'The agent was unable to retrieve any information from the OpenSearch corpus due to the MCP server not connecting during the session.' },
  { testCaseId: 'tc-1786588510345-lxkmdjnjp', reasoning: 'The agent was unable to retrieve any information from the corpus due to the OpenSearch MCP server not being available during the session.' },
  { testCaseId: 'tc-1786588543548-lym6rcmtq', reasoning: 'The agent was unable to retrieve any information from the OpenSearch index due to MCP server connectivity issues.' },
  { testCaseId: 'tc-1786588538505-9d8xx714x', reasoning: 'The agent was unable to retrieve any information from the OpenSearch index due to MCP server connectivity issues.' },
  { testCaseId: 'tc-1786588493237-opp5hjudf', reasoning: 'The agent was unable to retrieve any information from the corpus because the OpenSearch MCP server tools failed to load.' },
  { testCaseId: 'tc-1786588500265-aedheyei6', reasoning: 'The agent failed to retrieve any information from the knowledge base due to tool connectivity issues (OpenSearch MCP server tools were unavailable).' },
  { testCaseId: 'tc-1786588484201-h12md68qm', reasoning: 'The agent was unable to retrieve any information from the knowledge base due to tool connectivity issues.' },
  { testCaseId: 'tc-1786588514360-6jpbfrhe1', reasoning: 'The agent failed to retrieve any information from the corpus due to the OpenSearch MCP server not being available during the session.' },
  { testCaseId: 'tc-1786588546581-dtxnuo0ut', reasoning: 'The agent failed to retrieve any information from the corpus and provided no substantive answer.' },
  { testCaseId: 'tc-1786588517372-shrmai54v', reasoning: 'The agent failed to retrieve any information from the corpus and therefore provided none of the required facts.' },
  { testCaseId: 'tc-1786588525425-i5909x2al', reasoning: 'The agent was unable to access the OpenSearch index due to tool connectivity issues, resulting in zero required facts being stated.' },
  { testCaseId: 'tc-1786588529451-luvbguapq', reasoning: 'The agent was unable to retrieve any information from the corpus because the OpenSearch MCP server tools failed to load during the session.' },
  { testCaseId: 'tc-1786588488217-vykpejo4q', reasoning: 'The agent was unable to retrieve any information from the OpenSearch index because the MCP server tools were unavailable during the session.' },
  { testCaseId: 'tc-1786588531458-wl1z3egwa', reasoning: 'The agent was unable to retrieve any information from the corpus because the OpenSearch MCP server failed to connect during the session.' },
  { testCaseId: 'tc-1786588489221-om7vpf97d', reasoning: 'The agent was unable to retrieve any information from the OpenSearch index due to tool connectivity issues.' },
  { testCaseId: 'tc-1786588545556-fxx4wsmj4', reasoning: 'The agent was unable to retrieve any information from the corpus because the OpenSearch MCP server tools were unavailable during the session.' },
  { testCaseId: 'tc-1786588509342-1eg0ibssi', reasoning: 'The agent failed to retrieve any information from the corpus and therefore could not state any of the required facts.' },
  { testCaseId: 'tc-1786588533468-suununt2d', reasoning: 'The agent failed to retrieve any information from the knowledge base due to the OpenSearch MCP server not being available during the session.' },
  { testCaseId: 'tc-1786588501276-7ja35tmmm', reasoning: 'The agent was unable to retrieve any information from the OpenSearch index and returned a message stating it could not answer the question due to tooling connectivity issues.' },
  { testCaseId: 'tc-1786588524420-jkosfjr6v', reasoning: 'The agent failed to retrieve any information from the corpus due to tool connectivity issues, and therefore did not state any of the required facts:.' },
  { testCaseId: 'tc-1786588534471-v2m24tje7', reasoning: 'The agent was unable to retrieve any information from the corpus because the OpenSearch MCP server was not available during the session.' },
  { testCaseId: 'tc-1786588495244-g1qbkct8x', reasoning: 'The agent failed to retrieve any information from the knowledge corpus due to the OpenSearch MCP tools not being available.' },
  { testCaseId: 'tc-1786588504322-wzyr5go0q', reasoning: 'The agent was unable to retrieve any information from the corpus due to OpenSearch MCP tools not being available.' },
  { testCaseId: 'tc-1786588541540-umhj7kavl', reasoning: 'The agent was unable to retrieve any information from the OpenSearch index due to tool connectivity issues.' },
  { testCaseId: 'tc-1786588544552-2wzf7cgh7', reasoning: 'The agent failed to retrieve any information from the knowledge base due to tool unavailability.' },
  { testCaseId: 'tc-1786588499261-ds6hk11s7', reasoning: 'The agent failed to retrieve any information from the corpus because the OpenSearch MCP server tools never became available during the session.' },
  { testCaseId: 'tc-1786588537501-yaxgpy9xu', reasoning: 'The agent was unable to retrieve any information from the corpus because the OpenSearch MCP server failed to connect.' },
  { testCaseId: 'tc-1786588497253-r7kbxubee', reasoning: 'The agent was unable to access the OpenSearch index due to the MCP server not finishing its connection.' },
  { testCaseId: 'tc-1786588508338-qvme79mpe', reasoning: 'The agent failed to retrieve any information from the corpus due to a tool connectivity issue (OpenSearch MCP server not available).' },
  { testCaseId: 'tc-1786588518396-4eta0lszq', reasoning: 'The agent was unable to retrieve any information from the corpus due to the OpenSearch MCP server being unavailable.' },
  { testCaseId: 'tc-1786588507333-eypqyfxbr', reasoning: 'The agent failed to retrieve any information from the knowledge base due to the OpenSearch MCP server being unavailable.' },
  { testCaseId: 'tc-1786588519399-pvnc3or2b', reasoning: 'The agent was unable to retrieve any information from the corpus because the OpenSearch MCP server tools were unavailable during the session.' },
  { testCaseId: 'tc-1786588522412-cc5aitfkw', reasoning: 'The agent was unable to retrieve any documents from the corpus due to tool unavailability, so none of the 15 required facts were stated.' },
  { testCaseId: 'tc-1786588506330-txl4xveo3', reasoning: 'The agent failed to retrieve any information from the corpus and therefore could not answer the question.' },
  { testCaseId: 'tc-1786588530455-gbj6iy8ew', reasoning: 'The agent was unable to retrieve any information from the OpenSearch index due to tool connectivity issues.' },
  { testCaseId: 'tc-1786588523415-1l5zffw32', reasoning: 'The agent was unable to retrieve any information from the corpus because the OpenSearch MCP server tools were not available during the session.' },
  { testCaseId: 'tc-1786588540535-xc3dd55qn', reasoning: 'The agent failed to retrieve any information from the corpus because the OpenSearch MCP server tools were unavailable during the session.' },
  { testCaseId: 'tc-1786588496248-us29p7ssi', reasoning: 'The agent failed to retrieve any information from the corpus because the OpenSearch MCP server tools were unavailable during the session.' },
  { testCaseId: 'tc-1786588513356-czjxu52i3', reasoning: 'The agent was unable to retrieve any information from the corpus because the OpenSearch MCP server tools were not available during the session.' },
  { testCaseId: 'tc-1786588526428-1lyqj2u2y', reasoning: 'The agent failed to retrieve any information from the corpus because the OpenSearch MCP server tools were unavailable during the session.' },
  { testCaseId: 'tc-1786588494240-pvnqrog8o', reasoning: 'The agent failed to retrieve any information from the corpus due to tool unavailability.' },
  { testCaseId: 'tc-1786588521408-1ht8qumek', reasoning: 'The agent failed to retrieve any information from the corpus because the OpenSearch MCP tool never connected.' },
  { testCaseId: 'tc-1786588485204-rt9lsx04r', reasoning: 'The agent failed to retrieve the required information.' },
  { testCaseId: 'tc-1786588498257-rikwbtt7q', reasoning: 'The agent was unable to retrieve any information from the corpus due to tool availability issues (OpenSearch MCP server not connecting).' },
  { testCaseId: 'tc-1786588505326-8v6dxsdgo', reasoning: 'The agent was unable to retrieve any information from the corpus because the OpenSearch MCP server was not available during the session.' },

  // Genuinely different failure mode (missing required facts, not a
  // connectivity issue) — must NOT merge into the connectivity theme above.
  { testCaseId: 'tc-required-facts-0', reasoning: "Required facts evaluation: fact 0 was not stated in the agent's answer." },
  { testCaseId: 'tc-required-facts-1', reasoning: "Required facts evaluation: fact 1 was not stated in the agent's answer." },
  { testCaseId: 'tc-required-facts-2', reasoning: "Required facts evaluation: fact 2 was not stated in the agent's answer." },
  { testCaseId: 'tc-required-facts-3', reasoning: "Required facts evaluation: fact 3 was not stated in the agent's answer." },
  { testCaseId: 'tc-required-facts-4', reasoning: "Required facts evaluation: fact 4 was not stated in the agent's answer." },
  { testCaseId: 'tc-required-facts-5', reasoning: "Required facts evaluation: fact 5 was not stated in the agent's answer." },
  { testCaseId: 'tc-required-facts-6', reasoning: "Required facts evaluation: fact 6 was not stated in the agent's answer." },
];

