export const TEAM_SPEC_JSON_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://agentworkforce.dev/schemas/compose/team-spec.json',
  title: 'TeamSpec',
  type: 'object',
  required: ['id', 'lead', 'members'],
  additionalProperties: false,
  properties: {
    id: { type: 'string', minLength: 1 },
    lead: { type: 'string', minLength: 1 },
    members: {
      type: 'array', minItems: 1,
      items: {
        type: 'object', required: ['name', 'persona'], additionalProperties: false,
        properties: {
          name: { type: 'string', minLength: 1 },
          persona: {
            oneOf: [
              { type: 'string', minLength: 1 },
              {
                type: 'object',
                additionalProperties: false,
                properties: {
                  slug: { type: 'string', minLength: 1 },
                  version: { oneOf: [{ type: 'string', minLength: 1 }, { type: 'integer', minimum: 1 }] },
                  path: { type: 'string', minLength: 1 },
                  inline: { type: 'object' }
                },
                anyOf: [{ required: ['slug'] }, { required: ['path'] }, { required: ['inline'] }]
              }
            ]
          },
          role: { type: 'string', minLength: 1 },
          owns: { type: 'array', items: { type: 'object' } }
        }
      }
    },
    delegation: { type: 'array', items: { type: 'object' } },
    tokenBudget: { type: 'integer', minimum: 1, maximum: 2147483647 },
    timeBudgetSeconds: { type: 'integer', minimum: 1, maximum: 2147483647 }
  }
} as const;
