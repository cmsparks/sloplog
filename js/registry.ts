import { z, type ZodObject, type ZodRawShape } from 'zod';

// Re-export z for schema definitions
export { z };

// Allowed primitive Zod types for partials
type AllowedZodPrimitive =
  | z.ZodString
  | z.ZodNumber
  | z.ZodBoolean
  | z.ZodEnum<Record<string, string>>;

// Allowed types: primitives, arrays of primitives, or optional versions
type AllowedZodType =
  | AllowedZodPrimitive
  | z.ZodArray<AllowedZodPrimitive>
  | z.ZodOptional<AllowedZodPrimitive>
  | z.ZodOptional<z.ZodArray<AllowedZodPrimitive>>;

// Constraint type to ensure schema only uses allowed types
type AllowedShape = {
  [key: string]: AllowedZodType;
};

/**
 * Options for defining a partial
 */
export interface PartialOptions {
  /**
   * If true, multiple instances of this partial can be attached to a single wide event.
   * The partial will be stored as an array in the final log.
   * @default false
   */
  repeatable?: boolean;
  /**
   * If true, adding this partial to an event will mark the event to always be sampled.
   * Useful for error partials or other critical events that should never be dropped.
   * @default false
   */
  alwaysSample?: boolean;
  /**
   * Optional description used for generated docs and schemas.
   */
  description?: string;
}

// Partial definition with Zod schema
export interface PartialDefinition<
  T extends string,
  S extends ZodRawShape,
  O extends PartialOptions = PartialOptions,
> {
  /** Partial type discriminator */
  name: T;
  /** Zod schema for the partial payload */
  schema: ZodObject<S>;
  /** Repeatable and sampling behavior */
  options: O;
}

// Registry of all partials
export interface Registry<T extends PartialDefinition<string, ZodRawShape, PartialOptions>[]> {
  /** List of partial definitions that make up this registry */
  partials: T;
}

/**
 * Runtime metadata about partials, extracted from the registry for use by WideEvent
 */
export interface PartialMetadata {
  /** Whether this partial may appear multiple times */
  repeatable: boolean;
  /** Whether this partial forces alwaysSample for the event */
  alwaysSample: boolean;
}

/**
 * Callable partial definition that creates a partial payload from input data.
 */
export type PartialFactory<
  T extends string,
  S extends ZodRawShape,
  O extends PartialOptions = PartialOptions,
> = PartialDefinition<T, S, O> & {
  (data: z.input<ZodObject<S>>): z.infer<ZodObject<S>> & { type: T };
};

/**
 * Define a partial with a name and Zod schema
 * Only allows: z.string(), z.number(), z.boolean(), and their arrays/optionals
 *
 * @param name - The unique name/type discriminator for this partial
 * @param schema - Zod schema defining the partial's fields
 * @param options - Optional configuration for repeatable and alwaysSample behavior
 */
export function partial<
  T extends string,
  S extends AllowedShape,
  O extends PartialOptions = PartialOptions,
>(name: T, schema: S, options: O = {} as O): PartialFactory<T, S, O> {
  const objectSchema = z.object(schema);
  const describedSchema = options.description
    ? objectSchema.describe(options.description)
    : objectSchema;

  const factory = ((data: z.input<ZodObject<S>>) => {
    const parsed = describedSchema.parse(data);
    return { type: name, ...parsed } as z.infer<ZodObject<S>> & { type: T };
  }) as PartialFactory<T, S, O>;

  Object.defineProperty(factory, 'name', { value: name, configurable: true });
  factory.schema = describedSchema;
  factory.options = options;

  return factory;
}

/**
 * Create a registry of partials
 */
export function registry<T extends PartialDefinition<string, ZodRawShape, PartialOptions>[]>(
  partials: T,
): Registry<T> {
  return { partials };
}

/**
 * Extract runtime metadata from a registry for use by WideEvent
 */
export function extractPartialMetadata(
  reg: Registry<PartialDefinition<string, ZodRawShape, PartialOptions>[]>,
): Map<string, PartialMetadata> {
  const metadata = new Map<string, PartialMetadata>();
  for (const partial of reg.partials) {
    metadata.set(partial.name, {
      repeatable: partial.options.repeatable ?? false,
      alwaysSample: partial.options.alwaysSample ?? false,
    });
  }
  return metadata;
}

/**
 * Infer the TypeScript type from a partial definition
 */
export type InferPartial<T extends PartialDefinition<string, ZodRawShape>> = z.infer<
  T['schema']
> & { type: T['name'] };

type PartialValueFor<P extends PartialDefinition<string, ZodRawShape, PartialOptions>> =
  P['options'] extends { repeatable: true } ? InferPartial<P>[] : InferPartial<P>;

/**
 * Infer the registry log shape from a registry definition.
 */
export type RegistryType<
  T extends Registry<PartialDefinition<string, ZodRawShape, PartialOptions>[]>,
> = {
  [P in T['partials'][number] as P['name']]: PartialValueFor<P>;
};
