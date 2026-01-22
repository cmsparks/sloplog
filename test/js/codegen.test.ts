import { describe, it, expect } from 'vitest';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  partial,
  registry,
  z,
  generateTypeScript,
  generatePython,
  generateJsonSchema,
  type InferPartial,
} from '../../js/index';
import { config } from '../../js/codegen';

describe('Codegen DSL', () => {
  describe('partial()', () => {
    it('should create a partial definition with name and schema', () => {
      const user = partial('user', {
        userId: z.string(),
        name: z.string(),
      });

      expect(user.name).toBe('user');
      expect(user.schema).toBeDefined();
      expect(user.schema.shape).toBeDefined();
      expect(typeof user).toBe('function');

      const built = user({ userId: 'u1', name: 'Jane' });
      expect(built).toEqual({ type: 'user', userId: 'u1', name: 'Jane' });
    });

    it('should support string fields', () => {
      const p = partial('test', {
        field: z.string(),
      });

      expect(p.schema.shape.field).toBeDefined();
    });

    it('should support number fields', () => {
      const p = partial('test', {
        field: z.number(),
      });

      expect(p.schema.shape.field).toBeDefined();
    });

    it('should support boolean fields', () => {
      const p = partial('test', {
        field: z.boolean(),
      });

      expect(p.schema.shape.field).toBeDefined();
    });

    it('should support optional fields', () => {
      const p = partial('test', {
        required: z.string(),
        optional: z.string().optional(),
      });

      expect(p.schema.shape.required).toBeDefined();
      expect(p.schema.shape.optional).toBeDefined();
    });

    it('should support array fields', () => {
      const p = partial('test', {
        tags: z.string().array(),
        scores: z.number().array(),
      });

      expect(p.schema.shape.tags).toBeDefined();
      expect(p.schema.shape.scores).toBeDefined();
    });

    it('should support optional array fields', () => {
      const p = partial('test', {
        tags: z.string().array().optional(),
      });

      expect(p.schema.shape.tags).toBeDefined();
    });
  });

  describe('registry()', () => {
    it('should create a registry from partials', () => {
      const user = partial('user', { id: z.string() });
      const session = partial('session', { token: z.string() });

      const reg = registry([user, session]);

      expect(reg.partials).toHaveLength(2);
      expect(reg.partials[0].name).toBe('user');
      expect(reg.partials[1].name).toBe('session');
    });

    it('should work with empty registry', () => {
      const reg = registry([]);
      expect(reg.partials).toHaveLength(0);
    });
  });

  describe('InferPartial type', () => {
    it('should infer correct types from partial definition', () => {
      const _userPartial = partial('user', {
        id: z.string(),
        age: z.number(),
        active: z.boolean(),
      });

      // This is a compile-time check - if it compiles, the type inference works
      type UserPartial = InferPartial<typeof _userPartial>;

      // Runtime check that the type has the expected shape
      const testUser: UserPartial = {
        type: 'user',
        id: '123',
        age: 25,
        active: true,
      };

      expect(testUser.type).toBe('user');
      expect(testUser.id).toBe('123');
      expect(testUser.age).toBe(25);
      expect(testUser.active).toBe(true);
    });
  });
});

describe('generateTypeScript()', () => {
  it('should generate TypeScript interfaces for partials', () => {
    const user = partial('user', {
      userId: z.string(),
      name: z.string(),
    });

    const reg = registry([user]);
    const output = generateTypeScript(reg);

    expect(output).toContain('export interface UserPartial');
    expect(output).toContain('type: "user"');
    expect(output).toContain('userId: string');
    expect(output).toContain('name: string');
  });

  it('should handle optional fields with ? marker', () => {
    const error = partial('error', {
      message: z.string(),
      stack: z.string().optional(),
    });

    const reg = registry([error]);
    const output = generateTypeScript(reg);

    expect(output).toContain('message: string');
    expect(output).toContain('stack?: string');
  });

  it('should handle array fields', () => {
    const metrics = partial('metrics', {
      values: z.number().array(),
      labels: z.string().array(),
    });

    const reg = registry([metrics]);
    const output = generateTypeScript(reg);

    expect(output).toContain('values: number[]');
    expect(output).toContain('labels: string[]');
  });

  it('should handle optional array fields', () => {
    const data = partial('data', {
      tags: z.string().array().optional(),
    });

    const reg = registry([data]);
    const output = generateTypeScript(reg);

    expect(output).toContain('tags?: string[]');
  });

  it('should generate GeneratedRegistry type', () => {
    const user = partial('user', { id: z.string() });
    const session = partial('session', { token: z.string() });

    const reg = registry([user, session]);
    const output = generateTypeScript(reg);

    expect(output).toContain('export type GeneratedRegistry = {');
    expect(output).toContain('user: UserPartial');
    expect(output).toContain('session: SessionPartial');
  });

  it('should generate PartialName union type', () => {
    const user = partial('user', { id: z.string() });
    const session = partial('session', { token: z.string() });

    const reg = registry([user, session]);
    const output = generateTypeScript(reg);

    expect(output).toContain('export type PartialName = "user" | "session"');
  });

  it('should handle snake_case partial names', () => {
    const dbQuery = partial('db_query', {
      query: z.string(),
    });

    const reg = registry([dbQuery]);
    const output = generateTypeScript(reg);

    expect(output).toContain('export interface DbQueryPartial');
    expect(output).toContain('db_query: DbQueryPartial');
  });

  it('should include header comment and import', () => {
    const reg = registry([partial('test', { id: z.string() })]);
    const output = generateTypeScript(reg);

    expect(output).toContain('// Auto-generated by sloplog codegen - DO NOT EDIT');
    expect(output).toContain('import type { EventPartial, PartialMetadata } from "../index"');
  });
});

describe('generatePython()', () => {
  it('should generate Python TypedDicts for partials', () => {
    const user = partial('user', {
      userId: z.string(),
      name: z.string(),
    });

    const reg = registry([user]);
    const output = generatePython(reg);

    expect(output).toContain('class UserPartial(TypedDict):');
    expect(output).toContain('type: str');
    expect(output).toContain('user_id: str');
    expect(output).toContain('name: str');
  });

  it('should convert camelCase to snake_case', () => {
    const p = partial('test', {
      userId: z.string(),
      createdAt: z.number(),
      isActive: z.boolean(),
    });

    const reg = registry([p]);
    const output = generatePython(reg);

    expect(output).toContain('user_id: str');
    expect(output).toContain('created_at: float');
    expect(output).toContain('is_active: bool');
  });

  it('should handle optional fields with total=False pattern', () => {
    const error = partial('error', {
      message: z.string(),
      stack: z.string().optional(),
      code: z.number().optional(),
    });

    const reg = registry([error]);
    const output = generatePython(reg);

    expect(output).toContain('class _ErrorPartialRequired(TypedDict):');
    expect(output).toContain('message: str');
    expect(output).toContain('class ErrorPartial(_ErrorPartialRequired, total=False):');
    expect(output).toContain('stack: str');
    expect(output).toContain('code: float');
  });

  it('should handle all-optional partials', () => {
    const optional = partial('optional', {
      a: z.string().optional(),
      b: z.number().optional(),
    });

    const reg = registry([optional]);
    const output = generatePython(reg);

    expect(output).toContain('class OptionalPartial(TypedDict, total=False):');
  });

  it('should handle array fields', () => {
    const metrics = partial('metrics', {
      values: z.number().array(),
      labels: z.string().array(),
    });

    const reg = registry([metrics]);
    const output = generatePython(reg);

    expect(output).toContain('values: list[float]');
    expect(output).toContain('labels: list[str]');
  });

  it('should generate Union type for all partials', () => {
    const user = partial('user', { id: z.string() });
    const session = partial('session', { token: z.string() });

    const reg = registry([user, session]);
    const output = generatePython(reg);

    expect(output).toContain('GeneratedPartial = Union[UserPartial, SessionPartial]');
  });

  it('should generate GeneratedRegistry TypedDict', () => {
    const user = partial('user', { id: z.string() });
    const session = partial('session', { token: z.string() });

    const reg = registry([user, session]);
    const output = generatePython(reg);

    expect(output).toContain('class GeneratedRegistry(TypedDict):');
    expect(output).toContain('user: UserPartial');
    expect(output).toContain('session: SessionPartial');
  });

  it('should generate __all__ export list', () => {
    const user = partial('user', { id: z.string() });
    const session = partial('session', { token: z.string() });

    const reg = registry([user, session]);
    const output = generatePython(reg);

    expect(output).toContain('__all__ = [');
    expect(output).toContain('"UserPartial",');
    expect(output).toContain('"SessionPartial",');
    expect(output).toContain('"GeneratedPartial",');
    expect(output).toContain('"GeneratedRegistry",');
  });

  it('should include header comment and imports', () => {
    const reg = registry([partial('test', { id: z.string() })]);
    const output = generatePython(reg);

    expect(output).toContain('# Auto-generated by sloplog codegen - DO NOT EDIT');
    expect(output).toContain('from typing import TypedDict, Union');
  });
});

describe('generateJsonSchema()', () => {
  it('should generate JSON Schema for partials', () => {
    const user = partial('user', {
      userId: z.string(),
      age: z.number(),
    });

    const reg = registry([user]);
    const schema = generateJsonSchema(reg) as {
      $schema: string;
      $id: string;
      definitions: Record<string, object>;
    };

    expect(schema.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
    expect(schema.$id).toBe('sloplog-partials');
    expect(schema.definitions.user).toBeDefined();
  });

  it('should generate correct property types', () => {
    const test = partial('test', {
      str: z.string(),
      num: z.number(),
      bool: z.boolean(),
    });

    const reg = registry([test]);
    const schema = generateJsonSchema(reg) as {
      definitions: {
        test: {
          properties: Record<string, { type: string }>;
        };
      };
    };

    expect(schema.definitions.test.properties.str.type).toBe('string');
    expect(schema.definitions.test.properties.num.type).toBe('number');
    expect(schema.definitions.test.properties.bool.type).toBe('boolean');
  });

  it('should include type discriminator as const', () => {
    const user = partial('user', { id: z.string() });

    const reg = registry([user]);
    const schema = generateJsonSchema(reg) as {
      definitions: {
        user: {
          properties: { type: { const: string } };
        };
      };
    };

    expect(schema.definitions.user.properties.type.const).toBe('user');
  });

  it('should mark required fields correctly', () => {
    const error = partial('error', {
      message: z.string(),
      stack: z.string().optional(),
    });

    const reg = registry([error]);
    const schema = generateJsonSchema(reg) as {
      definitions: {
        error: {
          required: string[];
        };
      };
    };

    expect(schema.definitions.error.required).toContain('type');
    expect(schema.definitions.error.required).toContain('message');
    expect(schema.definitions.error.required).not.toContain('stack');
  });

  it('should handle array types', () => {
    const metrics = partial('metrics', {
      values: z.number().array(),
    });

    const reg = registry([metrics]);
    const schema = generateJsonSchema(reg) as {
      definitions: {
        metrics: {
          properties: {
            values: {
              type: string;
              items: { type: string };
            };
          };
        };
      };
    };

    expect(schema.definitions.metrics.properties.values.type).toBe('array');
    expect(schema.definitions.metrics.properties.values.items.type).toBe('number');
  });

  it('should set additionalProperties to false', () => {
    const user = partial('user', { id: z.string() });

    const reg = registry([user]);
    const schema = generateJsonSchema(reg) as {
      definitions: {
        user: {
          additionalProperties: boolean;
        };
      };
    };

    expect(schema.definitions.user.additionalProperties).toBe(false);
  });

  it('should include multiple partials in definitions', () => {
    const user = partial('user', { id: z.string() });
    const session = partial('session', { token: z.string() });

    const reg = registry([user, session]);
    const schema = generateJsonSchema(reg) as {
      definitions: Record<string, object>;
    };

    expect(Object.keys(schema.definitions)).toHaveLength(2);
    expect(schema.definitions.user).toBeDefined();
    expect(schema.definitions.session).toBeDefined();
  });
});

describe('config()', () => {
  it('should write python and jsonschema outputs', async () => {
    const user = partial('user', { id: z.string() });
    const reg = registry([user]);
    const outDir = await mkdtemp(join(tmpdir(), 'sloplog-'));

    const result = await config({ registry: reg, outDir });

    expect(result.python?.path).toBeDefined();
    expect(result.jsonschema?.path).toBeDefined();

    const python = await readFile(result.python!.path, 'utf8');
    expect(python).toContain('class UserPartial');

    const jsonschema = await readFile(result.jsonschema!.path, 'utf8');
    expect(jsonschema).toContain('"user"');
  });
});

describe('Type restriction enforcement', () => {
  it('should only allow primitive Zod types', () => {
    // These should all work (compile and run)
    const valid = partial('valid', {
      str: z.string(),
      num: z.number(),
      bool: z.boolean(),
      optStr: z.string().optional(),
      optNum: z.number().optional(),
      optBool: z.boolean().optional(),
      arrStr: z.string().array(),
      arrNum: z.number().array(),
      arrBool: z.boolean().array(),
      optArrStr: z.string().array().optional(),
    });

    expect(valid.name).toBe('valid');
    expect(Object.keys(valid.schema.shape)).toHaveLength(10);
  });

  // Note: The type system prevents using unsupported types at compile time
  // These tests verify the runtime behavior when processing schemas
  it('should throw error for unsupported Zod types at generation time', () => {
    // Create a schema with an unsupported type by bypassing TypeScript
    const invalidSchema = {
      field: z.date(), // Date is not allowed
    };

    // @ts-expect-error - intentionally passing invalid schema
    const invalid = partial('invalid', invalidSchema);
    const reg = registry([invalid]);

    expect(() => generateTypeScript(reg)).toThrow('Unsupported Zod type');
  });
});
