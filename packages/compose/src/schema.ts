const nonBlankString = { type: 'string', minLength: 1, pattern: '\\S' } as const;

export const TEAM_SPEC_JSON_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://agentworkforce.dev/schemas/compose/team-spec.json',
  title: 'TeamSpec',
  type: 'object',
  required: ['id', 'lead', 'members'],
  additionalProperties: false,
  properties: {
    id: nonBlankString,
    lead: nonBlankString,
    members: {
      type: 'array', minItems: 1,
      items: {
        type: 'object', required: ['name', 'persona'], additionalProperties: false,
        properties: {
          name: nonBlankString,
          persona: {
            oneOf: [
              nonBlankString,
              {
                type: 'object',
                additionalProperties: false,
                properties: {
                  slug: nonBlankString,
                  version: { oneOf: [nonBlankString, { type: 'integer', minimum: 1 }] },
                  path: nonBlankString,
                  inline: { type: 'object' }
                },
                anyOf: [{ required: ['slug'] }, { required: ['path'] }, { required: ['inline'] }]
              }
            ]
          },
          role: nonBlankString,
          owns: { type: 'array', items: { type: 'object' } }
        }
      }
    },
    delegation: { type: 'array', items: { type: 'object' } },
    tokenBudget: { type: 'integer', minimum: 1, maximum: 2147483647 },
    timeBudgetSeconds: { type: 'integer', minimum: 1, maximum: 2147483647 }
  }
} as const;
