import { statuses } from "./status.mjs";
const text = { type: "string" },
  instant = { type: "string", format: "date-time", nullable: true },
  status = { type: "string", enum: statuses };
const daily = {
  type: "object",
  required: [
    "date",
    "status",
    "uptimePercentage",
    "observedSeconds",
    "coveragePercentage",
  ],
  properties: {
    date: { type: "string", format: "date" },
    status,
    uptimePercentage: { type: "number", nullable: true },
    observedSeconds: { type: "integer" },
    maintenanceSeconds: { type: "integer" },
    coveragePercentage: { type: "number" },
  },
};
const stats = {
  history: { type: "array", items: daily },
  uptimePercentage: { type: "string", nullable: true },
  observedSeconds: { type: "integer" },
};
const component = {
  type: "object",
  required: ["id", "name", "status", "checkedAt", "history"],
  properties: {
    id: text,
    name: text,
    description: text,
    status,
    checkedAt: instant,
    latencyMs: { type: "integer", nullable: true },
    kind: text,
    url: text,
    ...stats,
  },
};
const incident = {
  type: "object",
  required: ["id", "title", "message", "componentIds", "phase", "updatedAt"],
  properties: {
    id: { type: "string", format: "uuid" },
    title: text,
    message: text,
    componentIds: { type: "array", items: text },
    severity: status,
    phase: {
      type: "string",
      enum: [
        "investigating",
        "identified",
        "monitoring",
        "resolved",
        "scheduled",
        "in_progress",
        "completed",
        "cancelled",
      ],
    },
    source: text,
    startedAt: instant,
    updatedAt: instant,
    resolvedAt: instant,
    scheduledStart: instant,
    scheduledEnd: instant,
    version: { type: "integer" },
    updates: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: text,
          message: text,
          phase: text,
          createdAt: instant,
        },
      },
    },
  },
};
const range = {
  type: "object",
  required: ["start", "end"],
  properties: {
    start: { type: "string", format: "date" },
    end: { type: "string", format: "date" },
  },
};
export const schemas = {
  StatusComponent: component,
  StatusIncident: incident,
  StatusSnapshot: {
    type: "object",
    required: [
      "overallStatus",
      "headline",
      "groups",
      "stale",
      "updatedAt",
      "range",
      "timeZone",
    ],
    properties: {
      title: text,
      overallStatus: status,
      headline: text,
      message: text,
      groups: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: text,
            name: text,
            status,
            ...stats,
            components: { type: "array", items: { $ref: "StatusComponent#" } },
          },
        },
      },
      activeIncidents: { type: "array", items: { $ref: "StatusIncident#" } },
      scheduledMaintenances: {
        type: "array",
        items: { $ref: "StatusIncident#" },
      },
      updatedAt: instant,
      stale: { type: "boolean" },
      range,
      timeZone: text,
      subscriptionsEnabled: { type: "boolean" },
    },
  },
  StatusHistory: {
    type: "object",
    properties: {
      title: text,
      range,
      months: {
        type: "array",
        items: {
          type: "object",
          properties: {
            key: text,
            incidents: { type: "array", items: { $ref: "StatusIncident#" } },
          },
        },
      },
      updatedAt: instant,
      stale: { type: "boolean" },
      timeZone: text,
    },
  },
  StatusError: {
    type: "object",
    required: ["error"],
    properties: {
      error: {
        type: "object",
        required: ["code", "message", "requestId"],
        properties: {
          code: text,
          message: text,
          requestId: { type: "string", format: "uuid" },
        },
      },
    },
  },
};
export const publicResponses = {
  "/api/v1/status": { $ref: "StatusSnapshot#" },
  "/api/v1/status-page": { $ref: "StatusSnapshot#" },
  "/api/v1/history": { $ref: "StatusHistory#" },
  "/api/v1/status-page/history": { $ref: "StatusHistory#" },
  "/api/v1/components/:id": { $ref: "StatusComponent#" },
  "/api/v1/incidents/:id": { $ref: "StatusIncident#" },
  "/api/v1/components": {
    type: "object",
    properties: {
      components: {
        type: "array",
        items: {
          ...component,
          properties: { ...component.properties, group: text, groupName: text },
        },
      },
    },
  },
  "/api/v1/summary": {
    type: "object",
    properties: {
      status,
      headline: text,
      updatedAt: instant,
      stale: { type: "boolean" },
      url: text,
      projects: {
        type: "array",
        items: { type: "object", properties: { id: text, name: text, status } },
      },
    },
  },
};
