#!/usr/bin/env npx tsx
/**
 * CLI for generating types from partial definitions
 *
 * Usage: npx tsx codegen/cli.ts <schema-file>
 *
 * Generates:
 *   - js/generated/partials.ts (TypeScript types)
 *   - python/wevt/generated/partials.py (Python TypedDicts)
 *   - schema/partials.json (JSON Schema)
 */

import { writeFileSync, mkdirSync, existsSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { generateTypeScript, generatePython, generateJsonSchema } from "../js/index.js"

async function main() {
    const schemaFile = process.argv[2] || "schema/partials.ts"
    const schemaPath = resolve(process.cwd(), schemaFile)

    console.log(`📖 Loading schema from ${schemaPath}...`)

    // Dynamically import the schema file
    const schemaModule = await import(schemaPath)
    const registry = schemaModule.default || schemaModule.registry

    if (!registry || !registry.partials) {
        console.error("❌ Schema file must export a registry created with registry()")
        process.exit(1)
    }

    console.log(`📦 Found ${registry.partials.length} partial(s):`)
    for (const partial of registry.partials) {
        const fieldCount = Object.keys(partial.schema.shape).length
        console.log(`   - ${partial.name} (${fieldCount} fields)`)
    }

    // Output paths
    const rootDir = process.cwd()
    const tsOutputPath = resolve(rootDir, "js/generated/partials.ts")
    const pyOutputPath = resolve(rootDir, "python/wevt/generated/partials.py")
    const jsonSchemaPath = resolve(rootDir, "schema/partials.json")

    // Ensure directories exist
    for (const outputPath of [tsOutputPath, pyOutputPath, jsonSchemaPath]) {
        const dir = dirname(outputPath)
        if (!existsSync(dir)) {
            mkdirSync(dir, { recursive: true })
            console.log(`📁 Created directory: ${dir}`)
        }
    }

    // Generate TypeScript
    console.log(`\n🔷 Generating TypeScript...`)
    const tsCode = generateTypeScript(registry)
    writeFileSync(tsOutputPath, tsCode)
    console.log(`   ✓ ${tsOutputPath}`)

    // Generate Python
    console.log(`🐍 Generating Python...`)
    const pyCode = generatePython(registry)
    writeFileSync(pyOutputPath, pyCode)
    console.log(`   ✓ ${pyOutputPath}`)

    // Generate JSON Schema
    console.log(`📋 Generating JSON Schema...`)
    const jsonSchema = generateJsonSchema(registry)
    writeFileSync(jsonSchemaPath, JSON.stringify(jsonSchema, null, 2))
    console.log(`   ✓ ${jsonSchemaPath}`)

    console.log(`\n✅ Code generation complete!`)
}

main().catch((err) => {
    console.error("❌ Error:", err.message)
    process.exit(1)
})
