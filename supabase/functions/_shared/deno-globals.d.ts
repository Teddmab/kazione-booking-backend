declare namespace Deno {
  interface Env {
    get(key: string): string | undefined;
  }

  const env: Env;

  interface TestDefinition {
    name: string;
    fn: () => void | Promise<void>;
  }

  function test(name: string, fn: () => void | Promise<void>): void;
  function test(definition: TestDefinition): void;

  function serve(
    handler: (req: Request) => Response | Promise<Response>,
  ): void;
}

declare module "https://deno.land/std@0.224.0/assert/mod.ts" {
  export function assertEquals(actual: unknown, expected: unknown, msg?: string): void;
}

declare module "https://deno.land/std/testing/asserts.ts" {
  export function assertEquals(actual: unknown, expected: unknown, msg?: string): void;
}
