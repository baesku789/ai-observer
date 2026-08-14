import entities from "./registries/entities.json" with { type: "json" };
import owners from "./registries/source-owners.json" with { type: "json" };
import pageRules from "./registries/page-rules.json" with { type: "json" };

export const registry = { entities: entities.entities, hosts: owners.hosts, pageRules: pageRules.rules };

