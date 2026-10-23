/// <reference path="../node_modules/@cloudflare/vitest-plugin/types/cloudflare-test.d.ts" />
import type { Env as AppEnv } from "../src/env";
declare global {
  namespace Cloudflare {
    interface Env extends AppEnv {}
  }
}
