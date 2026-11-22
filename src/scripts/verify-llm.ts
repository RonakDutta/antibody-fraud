import { z } from 'zod';
import { loadConfig } from '../config.js';
import { createModel } from '../integrations/models.js';
import { failureCode } from '../integrations/ports.js';

const config = loadConfig();
const model = createModel(config);
if (!model) {
  console.error('Configure a model in .env. See MANUAL_SETUP.md.');
  process.exitCode = 1;
} else {
  const schema = z.strictObject({ status: z.enum(['ok']) });
  const { $schema: _dialect, ...jsonSchema } = z.toJSONSchema(schema);
  const signal = AbortSignal.timeout(config.LLM_TIMEOUT_MS);
  try {
    const response = await model.generate('Return an object with status equal to ok.', 'Synthetic health check.', jsonSchema, signal);
    schema.parse(JSON.parse(response.text));
    console.log('Structured model response verified:', model.provider, model.model);
    console.log('Provider usage:', response.usage);
  } catch (error) {
    console.error('Model check failed (' + failureCode(error, signal, 'invalid_response_or_connection_error') + ').');
    process.exitCode = 1;
  }
}
