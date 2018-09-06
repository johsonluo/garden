/*
 * Copyright (C) 2018 Garden Technologies, Inc. <info@garden.io>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import * as Joi from "joi"
import { PluginContext } from "../plugin-context"
import { getEnvVarName } from "../util/util"
import { PrimitiveMap } from "../config/common"
import { Module, getModuleKey } from "./module"
import { serviceOutputsSchema, ServiceConfig } from "../config/service"
import { validate } from "../config/common"
import dedent = require("dedent")
import { format } from "url"
import normalizeUrl = require("normalize-url")

export interface Service<M extends Module = Module> {
  name: string
  module: M
  config: M["serviceConfigs"][0]
  spec: M["serviceConfigs"][0]["spec"]
}

export function serviceFromConfig<M extends Module = Module>(module: M, config: ServiceConfig): Service<M> {
  return {
    name: config.name,
    module,
    config,
    spec: config.spec,
  }
}

export type ServiceState = "ready" | "deploying" | "stopped" | "unhealthy" | "unknown" | "outdated" | "missing"

// TODO: support TCP, UDP and gRPC
export type ServiceProtocol = "http" | "https"  // | "tcp" | "udp"

export interface ServiceEndpointSpec {
  name: string
  hostname?: string
  path: string
  port: number
  protocol: ServiceProtocol
}

export interface ServiceEndpoint extends ServiceEndpointSpec {
  hostname: string
}

export const endpointHostnameSchema = Joi.string()
  .hostname()
  .description(dedent`
    The hostname that should route to this service. Defaults to the default hostname configured
    in the provider configuration.

    Note that if you're developing locally you may need to add this hostname to your hosts file.
  `)

const portSchema = Joi.number()
  .description(dedent`
    The port number that the service is exposed on internally.
    This defaults to the first specified port for the service.
  `)

export const serviceEndpointSpecSchema = Joi.object()
  .keys({
    name: Joi.string()
      .default("default")
      .description("A unique name for this endpoint."),
    hostname: endpointHostnameSchema,
    port: portSchema,
    path: Joi.string()
      .default("/")
      .description("The ingress path that should be matched to route to this service."),
    protocol: Joi.string()
      .only("http", "https")
      .required()
      .description("The protocol to use for the endpoint."),
  })

export const serviceEndpointSchema = serviceEndpointSpecSchema
  .keys({
    hostname: Joi.string()
      .required()
      .description("The hostname where the service can be accessed."),
    port: portSchema
      .required(),
  })
  .description("A description of a deployed service endpoint.")

// TODO: revise this schema
export interface ServiceStatus {
  providerId?: string
  providerVersion?: string
  version?: string
  state?: ServiceState
  runningReplicas?: number
  endpoints?: ServiceEndpoint[],
  lastMessage?: string
  lastError?: string
  createdAt?: string
  updatedAt?: string
  detail?: any
}

export const serviceStatusSchema = Joi.object()
  .keys({
    providerId: Joi.string()
      .description("The ID used for the service by the provider (if not the same as the service name)."),
    providerVersion: Joi.string()
      .description("The provider version of the deployed service (if different from the Garden module version."),
    version: Joi.string()
      .description("The Garden module version of the deployed service."),
    state: Joi.string()
      .only("ready", "deploying", "stopped", "unhealthy", "unknown", "outdated", "missing")
      .default("unknown")
      .description("The current deployment status of the service."),
    runningReplicas: Joi.number()
      .description("How many replicas of the service are currently running."),
    endpoints: Joi.array()
      .items(serviceEndpointSchema)
      .unique("name")
      .description("List of currently deployed endpoints for the service."),
    lastMessage: Joi.string()
      .allow("")
      .description("Latest status message of the service (if any)."),
    lastError: Joi.string()
      .description("Latest error status message of the service (if any)."),
    createdAt: Joi.string()
      .description("When the service was first deployed by the provider."),
    updatedAt: Joi.string()
      .description("When the service was last updated by the provider."),
    detail: Joi.object()
      .meta({ extendable: true })
      .description("Additional detail, specific to the provider."),
  })

export type RuntimeContext = {
  envVars: PrimitiveMap
  dependencies: {
    [name: string]: {
      version: string,
      outputs: PrimitiveMap,
    },
  },
  module: {
    name: string,
    type: string,
    version: string,
  },
}

export async function prepareRuntimeContext(
  ctx: PluginContext, module: Module, serviceDependencies: Service[],
): Promise<RuntimeContext> {
  const buildDepKeys = module.build.dependencies.map(dep => getModuleKey(dep.name, dep.plugin))
  const buildDependencies: Module[] = await ctx.getModules(buildDepKeys)
  const { versionString } = module.version
  const envVars = {
    GARDEN_VERSION: versionString,
  }

  for (const [key, value] of Object.entries(ctx.environmentConfig.variables)) {
    const envVarName = `GARDEN_VARIABLES_${key.replace(/-/g, "_").toUpperCase()}`
    envVars[envVarName] = value
  }

  const deps = {}

  for (const m of buildDependencies) {
    deps[m.name] = {
      version: m.version.versionString,
      outputs: {},
    }
  }

  for (const dep of serviceDependencies) {
    if (!deps[dep.name]) {
      deps[dep.name] = {
        version: dep.module.version.versionString,
        outputs: {},
      }
    }
    const depContext = deps[dep.name]

    const outputs = { ...await ctx.getServiceOutputs({ serviceName: dep.name }), ...dep.config.outputs }
    const serviceEnvName = getEnvVarName(dep.name)

    validate(outputs, serviceOutputsSchema, { context: `outputs for service ${dep.name}` })

    for (const [key, value] of Object.entries(outputs)) {
      const envVarName = `GARDEN_SERVICES_${serviceEnvName}_${key}`.toUpperCase()

      envVars[envVarName] = value
      depContext.outputs[key] = value
    }
  }

  return {
    envVars,
    dependencies: deps,
    module: {
      name: module.name,
      type: module.type,
      version: versionString,
    },
  }
}

export function getEndpointUrl(endpoint: ServiceEndpoint) {
  return normalizeUrl(format({
    protocol: endpoint.protocol,
    hostname: endpoint.hostname,
    port: endpoint.port,
    pathname: endpoint.path,
  }))
}