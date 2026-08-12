import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';

const nullableString = (maxLength) => ({ type: ['string', 'null'], maxLength });

const templateProperties = {
  name: { type: 'string', minLength: 1, maxLength: 128 },
  provider: { type: 'string', minLength: 1, maxLength: 64 },
  model: nullableString(256),
  color: { type: ['string', 'null'], pattern: '^#[0-9A-Fa-f]{6}$' },
  role: nullableString(128),
  skills: {
    type: ['array', 'null'],
    maxItems: 100,
    items: { type: 'string', minLength: 1, maxLength: 128 },
  },
  persona: nullableString(100_000),
  cliPath: nullableString(4_096),
  cliArgs: {
    type: ['array', 'null'],
    maxItems: 100,
    items: { type: 'string', maxLength: 4_096 },
  },
  harnessOptions: { type: ['object', 'null'], additionalProperties: true },
};

const inputSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'provider'],
  properties: templateProperties,
};

const persistedSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'name', 'provider', 'createdAt'],
  properties: {
    id: { type: 'string', minLength: 1, maxLength: 128 },
    ...templateProperties,
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
  },
};

const ajv = new Ajv({ allErrors: true, allowUnionTypes: true, strict: false });
addFormats(ajv);
const validateInput = ajv.compile(inputSchema);
const validatePersisted = ajv.compile({ type: 'array', items: persistedSchema });

function formatValidationErrors(errors = []) {
  return errors.map(error => `${error.instancePath || '/'} ${error.message}`);
}

export class AgentTemplateValidationError extends Error {
  constructor(errors) {
    super('Invalid agent template');
    this.name = 'AgentTemplateValidationError';
    this.code = 'AGENT_TEMPLATE_VALIDATION';
    this.details = formatValidationErrors(errors);
  }
}

export class AgentTemplateStoreCorruptError extends Error {
  constructor(filePath, cause) {
    super(`Agent template store is corrupt: ${filePath}`, { cause });
    this.name = 'AgentTemplateStoreCorruptError';
    this.code = 'AGENT_TEMPLATE_STORE_CORRUPT';
    this.filePath = filePath;
  }
}

export class AgentTemplateStore {
  constructor(filePath) {
    this.filePath = filePath;
  }

  list() {
    if (!existsSync(this.filePath)) return [];

    try {
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf8'));
      if (!validatePersisted(parsed)) {
        throw new AgentTemplateValidationError(validatePersisted.errors);
      }
      return parsed;
    } catch (err) {
      if (err?.code === 'ENOENT') return [];
      if (err instanceof AgentTemplateStoreCorruptError) throw err;
      throw new AgentTemplateStoreCorruptError(this.filePath, err);
    }
  }

  save(input) {
    if (!validateInput(input)) {
      throw new AgentTemplateValidationError(validateInput.errors);
    }

    const templates = this.list();
    const existing = templates.find(template => template.name === input.name);
    const now = new Date().toISOString();
    const template = {
      id: existing?.id || `tpl_${randomUUID()}`,
      name: input.name,
      provider: input.provider,
      ...Object.fromEntries(
        Object.keys(templateProperties)
          .filter(key => key !== 'name' && key !== 'provider' && input[key] !== undefined)
          .map(key => [key, input[key]])
      ),
      createdAt: existing?.createdAt || now,
      updatedAt: now,
    };

    this.#write([...templates.filter(item => item.name !== input.name), template]);
    return template;
  }

  delete(id) {
    const templates = this.list();
    const remaining = templates.filter(template => template.id !== id);
    if (remaining.length === templates.length) return false;
    this.#write(remaining);
    return true;
  }

  #write(templates) {
    const directory = dirname(this.filePath);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const tempPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      writeFileSync(tempPath, `${JSON.stringify(templates, null, 2)}\n`, {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o600,
      });
      renameSync(tempPath, this.filePath);
    } catch (err) {
      try { unlinkSync(tempPath); } catch { /* best-effort temporary-file cleanup */ }
      throw err;
    }
  }
}
