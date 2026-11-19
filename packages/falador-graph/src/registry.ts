// falador-graph — registry de tipos de nó (Spec §4/V5)
import type { NodeTypeDef } from './types.ts';

export class Registry {
  private defs = new Map<string, NodeTypeDef>();

  register(def: NodeTypeDef): this {
    if (this.defs.has(def.type)) {
      throw new Error(`tipo de nó já registrado: ${def.type}`);
    }
    this.defs.set(def.type, def);
    return this;
  }

  get(type: string): NodeTypeDef | undefined {
    return this.defs.get(type);
  }

  has(type: string): boolean {
    return this.defs.has(type);
  }

  types(): string[] {
    return [...this.defs.keys()].sort();
  }

  asMap(): Map<string, NodeTypeDef> {
    return new Map(this.defs);
  }
}

export function registryToMap(r: Registry): Map<string, NodeTypeDef> {
  return r.asMap();
}

export function createRegistry(): Registry {
  return new Registry();
}
