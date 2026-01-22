/**
 * Code generation utilities for sloplog partials
 *
 * Generates TypeScript, Python, and JSON Schema from partial definitions
 */

import type { ZodTypeAny, ZodObject, ZodRawShape } from 'zod';
import type { PartialDefinition, Registry } from './registry.js';

// Helper to detect Zod type info
interface ZodFieldInfo {
  baseType: 'string' | 'number' | 'boolean';
  isArray: boolean;
  isOptional: boolean;
  enumValues?: string[];
  description?: string;
}

function getZodFieldInfo(zodType: ZodTypeAny): ZodFieldInfo {
  let current = zodType;
  let isOptional = false;
  let isArray = false;
  let description: string | undefined;

  // Zod v4 uses _def.type instead of _def.typeName
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const getDefType = (t: ZodTypeAny): string => (t._def as any).type || (t._def as any).typeName;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const getDescription = (t: ZodTypeAny): string | undefined => (t._def as any).description;

  description = getDescription(current);

  // Unwrap optional
  if (getDefType(current) === 'optional') {
    isOptional = true;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    current = (current._def as any).innerType;
    description = description ?? getDescription(current);
  }

  // Unwrap array
  if (getDefType(current) === 'array') {
    isArray = true;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    current = (current._def as any).element;
    description = description ?? getDescription(current);
  }

  // Get base type
  let baseType: 'string' | 'number' | 'boolean';
  const defType = getDefType(current);
  let enumValues: string[] | undefined;
  switch (defType) {
    case 'string':
      baseType = 'string';
      break;
    case 'number':
      baseType = 'number';
      break;
    case 'boolean':
      baseType = 'boolean';
      break;
    case 'enum': {
      baseType = 'string';
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const def = current._def as any;
      const values = def.values ?? def.options;
      if (Array.isArray(values)) {
        enumValues = values.filter((value) => typeof value === 'string');
      } else if (def.entries && typeof def.entries === 'object') {
        enumValues = Object.values(def.entries).filter(
          (value) => typeof value === 'string',
        ) as string[];
      }
      break;
    }
    case 'nativeEnum': {
      baseType = 'string';
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const values = (current._def as any).values;
      if (values && typeof values === 'object') {
        enumValues = Object.values(values).filter((value) => typeof value === 'string') as string[];
      }
      break;
    }
    default:
      throw new Error(`Unsupported Zod type: ${defType}`);
  }

  return { baseType, isArray, isOptional, enumValues, description };
}

/**
 * Get the shape entries from a Zod schema, filtering out internal properties
 */
function getSchemaEntries(schema: ZodObject<ZodRawShape>): [string, ZodTypeAny][] {
  const shape = schema.shape;
  return Object.entries(shape).filter(([_key, value]) => {
    // Filter out non-Zod entries and internal properties
    return value && typeof value === 'object' && '_def' in value;
  }) as [string, ZodTypeAny][];
}

function getPartialDescription(def: PartialDefinition<string, ZodRawShape>): string | undefined {
  return def.options.description;
}

/**
 * Convert a partial schema to JSON Schema
 */
function partialToJsonSchema(def: PartialDefinition<string, ZodRawShape>): object {
  const properties: Record<string, object> = {
    type: { const: def.name },
  };
  const required: string[] = ['type'];
  const description = getPartialDescription(def);

  for (const [fieldName, zodType] of getSchemaEntries(def.schema)) {
    const {
      baseType,
      isArray,
      isOptional,
      enumValues,
      description: fieldDescription,
    } = getZodFieldInfo(zodType);

    const jsonType = baseType === 'number' ? 'number' : baseType;

    if (isArray) {
      const items: Record<string, unknown> = { type: jsonType };
      if (enumValues && enumValues.length > 0) {
        items.enum = enumValues;
      }
      properties[fieldName] = {
        type: 'array',
        items,
      };
    } else {
      const fieldSchema: Record<string, unknown> = { type: jsonType };
      if (enumValues && enumValues.length > 0) {
        fieldSchema.enum = enumValues;
      }
      properties[fieldName] = fieldSchema;
    }

    if (fieldDescription) {
      (properties[fieldName] as Record<string, unknown>).description = fieldDescription;
    }

    if (!isOptional) {
      required.push(fieldName);
    }
  }

  return {
    type: 'object',
    properties,
    required,
    additionalProperties: false,
    ...(description ? { description } : {}),
  };
}

/**
 * Generate full JSON Schema for a registry
 */
export function generateJsonSchema(
  reg: Registry<PartialDefinition<string, ZodRawShape>[]>,
): object {
  const definitions: Record<string, object> = {};
  const metadata: Record<string, { repeatable: boolean; alwaysSample: boolean }> = {};

  for (const partial of reg.partials) {
    definitions[partial.name] = partialToJsonSchema(partial);
    metadata[partial.name] = {
      repeatable: partial.options.repeatable ?? false,
      alwaysSample: partial.options.alwaysSample ?? false,
    };
  }

  // Generate registry schema showing the structure of a wide event log
  const registryProperties: Record<string, object> = {};
  for (const partial of reg.partials) {
    const isRepeatable = partial.options.repeatable ?? false;
    if (isRepeatable) {
      registryProperties[partial.name] = {
        type: 'array',
        items: { $ref: `#/definitions/${partial.name}` },
      };
    } else {
      registryProperties[partial.name] = {
        $ref: `#/definitions/${partial.name}`,
      };
    }
  }

  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'sloplog-partials',
    definitions,
    metadata,
    registry: {
      type: 'object',
      description: 'Structure of partial fields in a wide event log',
      properties: registryProperties,
      additionalProperties: false,
    },
  };
}

/**
 * Convert string to PascalCase
 */
function pascalCase(str: string): string {
  return str
    .split(/[-_]/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join('');
}

/**
 * Convert camelCase to snake_case
 */
function toSnakeCase(str: string): string {
  return str.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

/**
 * Generate TypeScript types for a registry
 */
export function generateTypeScript(
  reg: Registry<PartialDefinition<string, ZodRawShape>[]>,
): string {
  const lines: string[] = [
    '// Auto-generated by sloplog codegen - DO NOT EDIT',
    '// Source: sloplog registry',
    '',
    'import type { EventPartial, PartialMetadata } from "../index"',
    '',
  ];

  for (const partial of reg.partials) {
    const interfaceName = pascalCase(partial.name) + 'Partial';
    const partialDescription = getPartialDescription(partial);
    if (partialDescription) {
      lines.push(`/** ${partialDescription} */`);
    }
    lines.push(`export interface ${interfaceName} extends EventPartial<"${partial.name}"> {`);
    lines.push(`    type: "${partial.name}"`);

    for (const [fieldName, zodType] of getSchemaEntries(partial.schema)) {
      const {
        baseType,
        isArray,
        isOptional,
        enumValues,
        description: fieldDescription,
      } = getZodFieldInfo(zodType);
      const enumType = enumValues?.length
        ? enumValues.map((value) => JSON.stringify(value)).join(' | ')
        : baseType;
      const needsParens = isArray && enumValues && enumValues.length > 1;
      const fullType = isArray ? (needsParens ? `(${enumType})[]` : `${enumType}[]`) : enumType;
      const optionalMarker = isOptional ? '?' : '';
      if (fieldDescription) {
        lines.push(`    /** ${fieldDescription} */`);
      }
      lines.push(`    ${fieldName}${optionalMarker}: ${fullType}`);
    }

    lines.push('}');
    lines.push('');
  }

  // Generate the registry type - repeatable partials become arrays
  lines.push('// Registry type combining all partials');
  lines.push('// Repeatable partials are typed as arrays');
  lines.push('export type GeneratedRegistry = {');
  for (const partial of reg.partials) {
    const interfaceName = pascalCase(partial.name) + 'Partial';
    const isRepeatable = partial.options.repeatable ?? false;
    const registryType = isRepeatable ? `${interfaceName}[]` : interfaceName;
    lines.push(`    ${partial.name}: ${registryType}`);
  }
  lines.push('}');
  lines.push('');

  // Export partial names as a union
  const partialNames = reg.partials.map((p) => `"${p.name}"`).join(' | ');
  lines.push(`export type PartialName = ${partialNames || 'never'}`);
  lines.push('');

  // Export repeatable partial names
  const repeatableNames = reg.partials
    .filter((p) => p.options.repeatable)
    .map((p) => `"${p.name}"`)
    .join(' | ');
  lines.push(`export type RepeatablePartialName = ${repeatableNames || 'never'}`);
  lines.push('');

  // Export alwaysSample partial names
  const alwaysSampleNames = reg.partials
    .filter((p) => p.options.alwaysSample)
    .map((p) => `"${p.name}"`)
    .join(' | ');
  lines.push(`export type AlwaysSamplePartialName = ${alwaysSampleNames || 'never'}`);
  lines.push('');

  // Generate partial metadata constant for runtime use
  lines.push('// Runtime metadata for partials');
  lines.push('export const partialMetadata: Map<string, PartialMetadata> = new Map([');
  for (const partial of reg.partials) {
    const repeatable = partial.options.repeatable ?? false;
    const alwaysSample = partial.options.alwaysSample ?? false;
    lines.push(
      `    ["${partial.name}", { repeatable: ${repeatable}, alwaysSample: ${alwaysSample} }],`,
    );
  }
  lines.push(']);');
  lines.push('');

  return lines.join('\n');
}

/**
 * Convert Zod type to Python type annotation
 */
function zodFieldInfoToPython(info: ZodFieldInfo): { type: string; needsLiteral: boolean } {
  const { baseType, isArray, enumValues } = info;
  if (enumValues && enumValues.length > 0) {
    const literalType = `Literal[${enumValues.map((v) => JSON.stringify(v)).join(', ')}]`;
    return {
      type: isArray ? `list[${literalType}]` : literalType,
      needsLiteral: true,
    };
  }

  let pyType: string;
  switch (baseType) {
    case 'string':
      pyType = 'str';
      break;
    case 'number':
      pyType = 'float';
      break;
    case 'boolean':
      pyType = 'bool';
      break;
  }

  return { type: isArray ? `list[${pyType}]` : pyType, needsLiteral: false };
}

/**
 * Generate Python TypedDicts for a registry
 */
export function generatePython(reg: Registry<PartialDefinition<string, ZodRawShape>[]>): string {
  const typingImports = ['TypedDict'];
  const needsLiteral = reg.partials.some((partial) =>
    getSchemaEntries(partial.schema).some(
      ([, zodType]) => getZodFieldInfo(zodType).enumValues?.length,
    ),
  );
  if (needsLiteral) {
    typingImports.push('Literal');
  }
  if (reg.partials.length > 0) {
    typingImports.push('Union');
  } else {
    typingImports.push('Never');
  }
  const lines: string[] = [
    '# Auto-generated by sloplog codegen - DO NOT EDIT',
    '# Source: sloplog registry',
    '',
    `from typing import ${typingImports.join(', ')}`,
    '',
  ];

  for (const partial of reg.partials) {
    const className = pascalCase(partial.name) + 'Partial';
    const entries = getSchemaEntries(partial.schema);
    const partialDescription = getPartialDescription(partial);

    const hasOptional = entries.some(([_, zodType]) => getZodFieldInfo(zodType).isOptional);

    if (hasOptional) {
      const requiredFields = entries.filter(([_, zodType]) => !getZodFieldInfo(zodType).isOptional);
      const optionalFields = entries.filter(([_, zodType]) => getZodFieldInfo(zodType).isOptional);

      if (requiredFields.length > 0) {
        lines.push(`class _${className}Required(TypedDict):`);
        lines.push(`    """Required fields for ${partial.name} partial"""`);
        lines.push(`    type: str  # Literal["${partial.name}"]`);
        for (const [fieldName, zodType] of requiredFields) {
          const info = getZodFieldInfo(zodType);
          const { type: pyType } = zodFieldInfoToPython(info);
          if (info.description) {
            lines.push(`    # ${info.description}`);
          }
          lines.push(`    ${toSnakeCase(fieldName)}: ${pyType}`);
        }
        lines.push('');

        lines.push(`class ${className}(_${className}Required, total=False):`);
        lines.push(
          `    """${partialDescription ?? `${pascalCase(partial.name)} event partial`}"""`,
        );
        for (const [fieldName, zodType] of optionalFields) {
          const info = getZodFieldInfo(zodType);
          const { type: pyType } = zodFieldInfoToPython(info);
          if (info.description) {
            lines.push(`    # ${info.description}`);
          }
          lines.push(`    ${toSnakeCase(fieldName)}: ${pyType}`);
        }
      } else {
        lines.push(`class ${className}(TypedDict, total=False):`);
        lines.push(
          `    """${partialDescription ?? `${pascalCase(partial.name)} event partial`}"""`,
        );
        lines.push(`    type: str  # Literal["${partial.name}"] - required`);
        for (const [fieldName, zodType] of optionalFields) {
          const info = getZodFieldInfo(zodType);
          const { type: pyType } = zodFieldInfoToPython(info);
          if (info.description) {
            lines.push(`    # ${info.description}`);
          }
          lines.push(`    ${toSnakeCase(fieldName)}: ${pyType}`);
        }
      }
    } else {
      lines.push(`class ${className}(TypedDict):`);
      lines.push(`    """${partialDescription ?? `${pascalCase(partial.name)} event partial`}"""`);
      lines.push(`    type: str  # Literal["${partial.name}"]`);
      for (const [fieldName, zodType] of entries) {
        const info = getZodFieldInfo(zodType);
        const { type: pyType } = zodFieldInfoToPython(info);
        if (info.description) {
          lines.push(`    # ${info.description}`);
        }
        lines.push(`    ${toSnakeCase(fieldName)}: ${pyType}`);
      }
    }
    lines.push('');
  }

  // Generate union type for all partials
  const partialTypes = reg.partials.map((p) => pascalCase(p.name) + 'Partial');
  lines.push('# Union of all partial types');
  if (partialTypes.length > 0) {
    lines.push(`GeneratedPartial = Union[${partialTypes.join(', ')}]`);
  } else {
    lines.push('GeneratedPartial = Never');
  }
  lines.push('');

  // Generate registry type - repeatable partials become lists
  lines.push('# Registry mapping partial names to their types');
  lines.push('# Repeatable partials are typed as lists');
  lines.push('class GeneratedRegistry(TypedDict):');
  lines.push('    """Type-safe registry of all event partials"""');
  for (const partial of reg.partials) {
    const className = pascalCase(partial.name) + 'Partial';
    const isRepeatable = partial.options.repeatable ?? false;
    const registryType = isRepeatable ? `list[${className}]` : className;
    lines.push(`    ${partial.name}: ${registryType}`);
  }
  lines.push('');

  // Generate PartialMetadata TypedDict
  lines.push('class PartialMetadata(TypedDict):');
  lines.push('    """Metadata about a partial type"""');
  lines.push('    repeatable: bool');
  lines.push('    always_sample: bool');
  lines.push('');

  // Generate partial metadata dict for runtime use
  lines.push('# Runtime metadata for partials');
  lines.push('PARTIAL_METADATA: dict[str, PartialMetadata] = {');
  for (const partial of reg.partials) {
    const repeatable = partial.options.repeatable ?? false;
    const alwaysSample = partial.options.alwaysSample ?? false;
    lines.push(
      `    "${partial.name}": {"repeatable": ${repeatable ? 'True' : 'False'}, "always_sample": ${alwaysSample ? 'True' : 'False'}},`,
    );
  }
  lines.push('}');
  lines.push('');

  // Export list
  lines.push('__all__ = [');
  for (const partial of reg.partials) {
    lines.push(`    "${pascalCase(partial.name)}Partial",`);
  }
  lines.push('    "GeneratedPartial",');
  lines.push('    "GeneratedRegistry",');
  lines.push('    "PartialMetadata",');
  lines.push('    "PARTIAL_METADATA",');
  lines.push(']');
  lines.push('');

  return lines.join('\n');
}

export type CodegenOutputKind = 'python' | 'jsonschema';

export type CodegenOutputs =
  | CodegenOutputKind[]
  | {
      python?: string | false;
      jsonschema?: string | false;
    };

export interface CodegenConfig {
  registry: string | Registry<PartialDefinition<string, ZodRawShape>[]>;
  outDir?: string;
  outputs?: CodegenOutputs;
}

export interface CodegenResult {
  python?: { path: string; code: string };
  jsonschema?: { path: string; code: string };
}

function resolveOutputs(outputs: CodegenOutputs | undefined): {
  python?: string;
  jsonschema?: string;
} {
  const defaults = { python: 'sloplog.py', jsonschema: 'sloplog.json' };
  if (!outputs) {
    return defaults;
  }

  if (Array.isArray(outputs)) {
    return {
      python: outputs.includes('python') ? defaults.python : undefined,
      jsonschema: outputs.includes('jsonschema') ? defaults.jsonschema : undefined,
    };
  }

  const resolved: { python?: string; jsonschema?: string } = {};
  if (outputs.python !== undefined) {
    resolved.python = outputs.python === false ? undefined : (outputs.python ?? defaults.python);
  }
  if (outputs.jsonschema !== undefined) {
    resolved.jsonschema =
      outputs.jsonschema === false ? undefined : (outputs.jsonschema ?? defaults.jsonschema);
  }
  return resolved;
}

function isRegistry(value: unknown): value is Registry<PartialDefinition<string, ZodRawShape>[]> {
  if (!value || typeof value !== 'object') {
    return false;
  }
  return Array.isArray((value as { partials?: unknown }).partials);
}

async function loadRegistry(
  registry: CodegenConfig['registry'],
  resolvePath: (path: string) => string,
  pathToFileURL: (path: string) => URL,
): Promise<Registry<PartialDefinition<string, ZodRawShape>[]>> {
  if (typeof registry !== 'string') {
    if (isRegistry(registry)) {
      return registry;
    }
    throw new Error('sloplog registry must include a partials array');
  }

  const registryPath = resolvePath(registry);
  const module = await import(pathToFileURL(registryPath).href);
  const resolved = (module.default || module.registry) as
    | Registry<PartialDefinition<string, ZodRawShape>[]>
    | undefined;

  if (!resolved || !isRegistry(resolved)) {
    throw new Error('sloplog registry file must export a registry created with registry()');
  }

  return resolved;
}

/**
 * Generate outputs from a sloplog registry (Python + JSON schema).
 */
export async function config(config: CodegenConfig): Promise<CodegenResult> {
  const [{ mkdir, writeFile }, pathModule, urlModule] = await Promise.all([
    import('node:fs/promises'),
    import('node:path'),
    import('node:url'),
  ]);
  const { resolve, dirname, isAbsolute } = pathModule;
  const { pathToFileURL } = urlModule;

  const registry = await loadRegistry(config.registry, resolve, pathToFileURL);
  const outDir = resolve(config.outDir ?? './generated');
  const outputs = resolveOutputs(config.outputs);
  const result: CodegenResult = {};

  if (outputs.python) {
    const code = generatePython(registry);
    const outputPath = isAbsolute(outputs.python)
      ? outputs.python
      : resolve(outDir, outputs.python);
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${code}\n`, 'utf8');
    result.python = { path: outputPath, code };
  }

  if (outputs.jsonschema) {
    const schema = generateJsonSchema(registry);
    const code = `${JSON.stringify(schema, null, 2)}\n`;
    const outputPath = isAbsolute(outputs.jsonschema)
      ? outputs.jsonschema
      : resolve(outDir, outputs.jsonschema);
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, code, 'utf8');
    result.jsonschema = { path: outputPath, code };
  }

  return result;
}
