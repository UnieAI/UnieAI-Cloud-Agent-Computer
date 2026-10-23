import { loadAll } from "js-yaml";

export function normalizeDnsLabel(value, maxLength = 63) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");

  return normalized.slice(0, maxLength).replace(/-+$/, "");
}

export function resolveWildcardBaseDomain(dnsWildcardDomain) {
  return String(dnsWildcardDomain || "")
    .trim()
    .replace(/^\*\./, "")
    .replace(/\.+$/, "");
}

export function scoreServicePort(port = {}) {
  const name = String(port.name || "").trim().toLowerCase();
  const appProtocol = String(port.appProtocol || "").trim().toLowerCase();
  const portNumber = Math.max(0, Number(port.port || 0) || 0);
  let score = 0;
  let reason = "Fallback to the first TCP service port";

  if (appProtocol.includes("http")) {
    score += 140;
    reason = `App protocol ${appProtocol} indicates HTTP traffic`;
  }

  if (name === "http" || name.startsWith("http-") || name.endsWith("-http")) {
    score += 120;
    reason = `Port name ${name || "http"} strongly suggests HTTP traffic`;
  } else if (name.includes("web")) {
    score += 110;
    reason = `Port name ${name} suggests a web entrypoint`;
  } else if (name.includes("https")) {
    score += 100;
    reason = `Port name ${name} suggests HTTPS traffic`;
  }

  if (portNumber === 80) {
    score += 95;
    reason = "Port 80 is a common web service port";
  } else if (portNumber === 443) {
    score += 90;
    reason = "Port 443 is a common HTTPS service port";
  } else if (portNumber === 8080) {
    score += 88;
    reason = "Port 8080 is a common application web port";
  } else if (portNumber === 8000) {
    score += 84;
    reason = "Port 8000 is a common application web port";
  } else if (portNumber === 3000) {
    score += 82;
    reason = "Port 3000 is a common application web port";
  } else if (portNumber === 7860) {
    score += 80;
    reason = "Port 7860 is commonly used by web model UIs";
  }

  return { score, reason };
}

export function expandRenderedObjects(document) {
  if (!document || typeof document !== "object") {
    return [];
  }

  if (document.kind === "List" && Array.isArray(document.items)) {
    return document.items.flatMap((item) => expandRenderedObjects(item));
  }

  return [document];
}

export function resolveGeneratedIngressServiceLabel({ serviceName, projectSlug }) {
  const normalizedServiceName = normalizeDnsLabel(serviceName || "", 63);
  const normalizedProjectSlug = normalizeDnsLabel(projectSlug || "", 63);
  if (!normalizedServiceName) {
    return "";
  }

  const trialPrefixes = [
    normalizedProjectSlug ? `unieai-${normalizedProjectSlug}-` : "",
    "unieai-",
    normalizedProjectSlug ? `${normalizedProjectSlug}-` : ""
  ].filter(Boolean);

  for (const prefix of trialPrefixes) {
    if (!normalizedServiceName.startsWith(prefix)) {
      continue;
    }

    const shortened = normalizeDnsLabel(normalizedServiceName.slice(prefix.length), 63);
    if (shortened) {
      return shortened;
    }
  }

  return normalizedServiceName;
}

export function buildGeneratedIngressHostname({ serviceLabel, projectSlug, baseDomain }) {
  const normalizedServiceLabel = normalizeDnsLabel(serviceLabel || "", 63);
  const normalizedProjectSlug = normalizeDnsLabel(projectSlug || "", 63);
  const normalizedBaseDomain = resolveWildcardBaseDomain(baseDomain);

  if (!normalizedServiceLabel || !normalizedProjectSlug || !normalizedBaseDomain) {
    return "";
  }

  return `${normalizedServiceLabel}.${normalizedProjectSlug}.${normalizedBaseDomain}`;
}

function buildServiceKey(namespace, name) {
  const normalizedNamespace = normalizeDnsLabel(namespace || "default", 63) || "default";
  const normalizedName = normalizeDnsLabel(name || "", 63);
  return normalizedName ? `${normalizedNamespace}/${normalizedName}` : "";
}

function buildPortKey(port = {}) {
  return `${String(port?.name || "").trim()}:${Math.max(0, Number(port?.port || 0) || 0)}`;
}

function findCandidatePort(candidatePorts = [], selection = null) {
  if (!selection || typeof selection !== "object") {
    return null;
  }

  const requestedPort = Math.max(0, Number(selection.port || 0) || 0);
  const requestedName = String(selection.name || "").trim();
  const requestedKey = buildPortKey({ name: requestedName, port: requestedPort });

  return (
    candidatePorts.find((candidate) => buildPortKey(candidate) === requestedKey)
    || candidatePorts.find((candidate) => requestedPort > 0 && Number(candidate.port || 0) === requestedPort && String(candidate.name || "").trim() === requestedName)
    || candidatePorts.find((candidate) => requestedPort > 0 && Number(candidate.port || 0) === requestedPort)
    || null
  );
}

function canRouteService(service) {
  return !service?.externalName && !service?.headless && Array.isArray(service?.candidatePorts) && service.candidatePorts.length > 0;
}

export function normalizeGeneratedIngressConfig(config = null) {
  const services = Array.isArray(config?.services)
    ? config.services
      .map((service) => {
        const name = normalizeDnsLabel(service?.name || "", 63);
        const namespace = normalizeDnsLabel(service?.namespace || "default", 63) || "default";
        if (!name) {
          return null;
        }

        const selectedPort = service?.selectedPort && typeof service.selectedPort === "object"
          ? {
              name: String(service.selectedPort.name || "").trim(),
              port: Math.max(0, Number(service.selectedPort.port || 0) || 0)
            }
          : null;
        const serviceLabel = normalizeDnsLabel(service?.serviceLabel || "", 63);

        return {
          name,
          namespace,
          ingressEnabled: Boolean(service?.ingressEnabled),
          selectedPort: selectedPort && selectedPort.port > 0 ? selectedPort : null,
          serviceLabel
        };
      })
      .filter(Boolean)
      .sort((left, right) => left.namespace.localeCompare(right.namespace) || left.name.localeCompare(right.name))
    : [];

  return { services };
}

function validateGeneratedIngressServices(services = []) {
  const hostnameMap = new Map();

  for (const service of services) {
    if (!service?.ingressEnabled || !service?.hostname || !service?.selectedPort?.port) {
      continue;
    }

    const key = String(service.hostname || "").trim().toLowerCase();
    if (!key) {
      continue;
    }

    if (!hostnameMap.has(key)) {
      hostnameMap.set(key, []);
    }
    hostnameMap.get(key).push(service);
  }

  const duplicateErrors = new Map();
  for (const [hostname, duplicateServices] of hostnameMap.entries()) {
    if (duplicateServices.length < 2) {
      continue;
    }

    const serviceRefs = duplicateServices
      .map((service) => `${service.namespace || "default"}/${service.name || "service"}`)
      .join(", ");
    const message = `Duplicate hostname ${hostname} resolved for ${serviceRefs}. Choose different service labels.`;

    for (const service of duplicateServices) {
      duplicateErrors.set(buildServiceKey(service.namespace, service.name), message);
    }
  }

  const nextServices = services.map((service) => {
    const validationError = duplicateErrors.get(buildServiceKey(service.namespace, service.name)) || "";
    return {
      ...service,
      validationError
    };
  });

  return {
    services: nextServices,
    validationErrors: Array.from(new Set(nextServices.map((service) => service.validationError).filter(Boolean)))
  };
}

export function discoverServicesFromManifest(renderedManifest, { projectSlug, dnsWildcardDomain, defaultNamespace = "default" }) {
  const baseDomain = resolveWildcardBaseDomain(dnsWildcardDomain);
  const normalizedDefaultNamespace = normalizeDnsLabel(defaultNamespace || "default", 63) || "default";
  const documents = loadAll(String(renderedManifest || "")).flatMap((document) => expandRenderedObjects(document));
  const services = documents
    .filter((document) => String(document?.kind || "").trim() === "Service")
    .map((service) => {
      const metadata = service?.metadata || {};
      const spec = service?.spec || {};
      const namespace = normalizeDnsLabel(metadata.namespace || normalizedDefaultNamespace, 63) || normalizedDefaultNamespace;
      const type = String(spec.type || "ClusterIP").trim() || "ClusterIP";
      const headless = String(spec.clusterIP || "").trim().toLowerCase() === "none";
      const externalName = type === "ExternalName";
      const candidatePorts = (Array.isArray(spec.ports) ? spec.ports : [])
        .map((port) => {
          const protocol = String(port?.protocol || "TCP").trim().toUpperCase() || "TCP";
          const portNumber = Math.max(0, Number(port?.port || 0) || 0);
          const recommendation = scoreServicePort({
            name: port?.name,
            port: portNumber,
            appProtocol: port?.appProtocol
          });

          return {
            name: String(port?.name || "").trim(),
            port: portNumber,
            targetPort: port?.targetPort ?? null,
            protocol,
            appProtocol: String(port?.appProtocol || "").trim(),
            preferenceScore: recommendation.score,
            recommendationReason: recommendation.reason
          };
        })
        .filter((port) => port.protocol === "TCP" && port.port > 0)
        .sort((left, right) => right.preferenceScore - left.preferenceScore || left.port - right.port || left.name.localeCompare(right.name));

      const recommendedPort = candidatePorts[0] || null;
      return {
        name: normalizeDnsLabel(metadata.name || "", 63),
        namespace,
        type,
        clusterIP: String(spec.clusterIP || "").trim(),
        headless,
        externalName,
        skippedReason:
          externalName
            ? "ExternalName services are not supported for generated ingress."
            : headless
              ? "Headless services are skipped because ingress requires a stable Service backend."
              : candidatePorts.length === 0
                ? "No TCP service ports were available for generated ingress."
                : "",
        candidatePorts: candidatePorts.map((port, index) => ({
          ...port,
          recommended: index === 0
        })),
        recommendedPort,
        selectedPort: recommendedPort,
        ingressEnabled: Boolean(baseDomain && recommendedPort && !externalName && !headless),
        defaultServiceLabel: resolveGeneratedIngressServiceLabel({
          serviceName: metadata.name || "",
          projectSlug
        }),
        serviceLabel: "",
        hostname: "",
        ingressName: "",
        ingressNamespace: "",
        tlsSecretName: "",
        validationError: ""
      };
    })
    .filter((service) => service.name);

  const { services: servicesWithHosts, validationErrors } = validateGeneratedIngressServices(services.map((service) => {
    if (!service.ingressEnabled || !baseDomain) {
      return {
        ...service,
        serviceLabel: service.defaultServiceLabel || ""
      };
    }

    const serviceLabel = service.defaultServiceLabel || resolveGeneratedIngressServiceLabel({
      serviceName: service.name,
      projectSlug
    });

    return {
      ...service,
      serviceLabel,
      hostname: buildGeneratedIngressHostname({
        serviceLabel,
        projectSlug,
        baseDomain
      })
    };
  }));

  return {
    mode: baseDomain ? "kubernetes-ingress" : "disabled",
    discoveredAt: new Date().toISOString(),
    dnsWildcardDomain: String(dnsWildcardDomain || ""),
    baseDomain,
    projectSlug: String(projectSlug || "").trim(),
    serviceCount: servicesWithHosts.length,
    routableServiceCount: servicesWithHosts.filter((service) => service.ingressEnabled && service.hostname && service.selectedPort && !service.validationError).length,
    services: servicesWithHosts,
    hostnames: servicesWithHosts.map((service) => (service.validationError ? "" : service.hostname)).filter(Boolean),
    validationErrors
  };
}

export function applyGeneratedIngressCustomization(discovery, config = null) {
  const normalizedConfig = normalizeGeneratedIngressConfig(config);
  const selectionMap = new Map(
    normalizedConfig.services.map((service) => [
      buildServiceKey(service.namespace, service.name),
      service
    ])
  );
  const baseDomain = resolveWildcardBaseDomain(discovery?.dnsWildcardDomain || "");
  const { services, validationErrors } = validateGeneratedIngressServices((Array.isArray(discovery?.services) ? discovery.services : []).map((service) => {
    const selection = selectionMap.get(buildServiceKey(service?.namespace, service?.name));
    const candidatePorts = Array.isArray(service?.candidatePorts) ? service.candidatePorts : [];
    const selectedPort = findCandidatePort(candidatePorts, selection?.selectedPort) || service?.recommendedPort || candidatePorts[0] || null;
    const selectable = canRouteService(service);
    const wantsIngress = selection ? Boolean(selection.ingressEnabled) : Boolean(baseDomain && selectedPort && selectable);
    const ingressEnabled = Boolean(baseDomain && wantsIngress && selectedPort && selectable);
    const defaultServiceLabel = service?.defaultServiceLabel
      || resolveGeneratedIngressServiceLabel({
        serviceName: service?.name,
        projectSlug: discovery?.projectSlug || ""
      });
    const serviceLabel = selection?.serviceLabel || service?.serviceLabel || defaultServiceLabel || "";

    return {
      ...service,
      defaultServiceLabel,
      serviceLabel,
      selectedPort,
      ingressEnabled,
      hostname: ingressEnabled
        ? buildGeneratedIngressHostname({
            serviceLabel,
            projectSlug: discovery?.projectSlug || "",
            baseDomain
          })
        : "",
      skippedReason:
        service?.skippedReason
          ? service.skippedReason
          : !baseDomain
            ? ""
            : wantsIngress && !selectedPort
              ? "The selected ingress port is no longer available in the rendered manifest."
              : !wantsIngress
                ? "Ingress disabled in request."
                : ""
    };
  }));

  return {
    ...discovery,
    dnsWildcardDomain: String(discovery?.dnsWildcardDomain || ""),
    baseDomain,
    services,
    hostnames: services.map((service) => (service.validationError ? "" : service.hostname)).filter(Boolean),
    routableServiceCount: services.filter((service) => service.ingressEnabled && service.hostname && service.selectedPort && !service.validationError).length,
    validationErrors
  };
}

export function buildGeneratedIngressPlan(discovery, { releaseName, chartName, ingressClassName, clusterIssuerName, generatedIngressConfig = null } = {}) {
  const customizedDiscovery = applyGeneratedIngressCustomization(discovery, generatedIngressConfig);
  const ingressName = normalizeDnsLabel(`${releaseName}-generated`, 63) || "generated";
  const tlsSecretName = normalizeDnsLabel(`${releaseName}-generated-tls`, 63) || "generated-tls";
  const groupedServices = new Map();

  for (const service of Array.isArray(customizedDiscovery?.services) ? customizedDiscovery.services : []) {
    if (!service?.ingressEnabled || !service?.hostname || !service?.selectedPort?.port || service?.validationError) {
      continue;
    }

    const namespace = normalizeDnsLabel(service.namespace || "default", 63) || "default";
    if (!groupedServices.has(namespace)) {
      groupedServices.set(namespace, []);
    }
    groupedServices.get(namespace).push(service);
  }

  const services = (Array.isArray(customizedDiscovery?.services) ? customizedDiscovery.services : []).map((service) => {
    if (!service?.ingressEnabled || !service?.hostname || !service?.selectedPort?.port || service?.validationError) {
      return service;
    }

    return {
      ...service,
      ingressName,
      ingressNamespace: normalizeDnsLabel(service.namespace || "default", 63) || "default",
      tlsSecretName
    };
  });

  const resources = Array.from(groupedServices.entries()).map(([namespace, namespaceServices]) => ({
    namespace,
    ingressName,
    tlsSecretName,
    hostnames: namespaceServices.map((service) => service.hostname),
    body: {
      apiVersion: "networking.k8s.io/v1",
      kind: "Ingress",
      metadata: {
        name: ingressName,
        namespace,
        labels: {
          "app.kubernetes.io/instance": String(releaseName || "").trim(),
          "app.kubernetes.io/name": String(chartName || releaseName || "generated-ingress").trim(),
          "app.kubernetes.io/managed-by": "unieai-onprem-deploy-worker"
        },
        annotations: {
          "cert-manager.io/cluster-issuer": String(clusterIssuerName || "").trim(),
          "kubernetes.io/ingress.class": String(ingressClassName || "").trim(),
          "traefik.ingress.kubernetes.io/router.entrypoints": "web,websecure",
          "traefik.ingress.kubernetes.io/router.tls": "true"
        }
      },
      spec: {
        ingressClassName: String(ingressClassName || "").trim(),
        tls: [
          {
            hosts: namespaceServices.map((service) => service.hostname),
            secretName: tlsSecretName
          }
        ],
        rules: namespaceServices.map((service) => ({
          host: service.hostname,
          http: {
            paths: [
              {
                path: "/",
                pathType: "Prefix",
                backend: {
                  service: {
                    name: service.name,
                    port: {
                      number: Number(service.selectedPort.port)
                    }
                  }
                }
              }
            ]
          }
        }))
      }
    }
  }));

  return {
    ...customizedDiscovery,
    ingressClassName,
    clusterIssuerName,
    generatedIngressCount: resources.length,
    generatedIngressConfig: normalizeGeneratedIngressConfig(generatedIngressConfig),
    services,
    resources: resources.map(({ namespace, ingressName: resourceName, tlsSecretName: secretName, hostnames }) => ({
      namespace,
      ingressName: resourceName,
      tlsSecretName: secretName,
      hostnames
    })),
    resourceBodies: resources
  };
}

export function sanitizeGeneratedIngress(plan) {
  if (!plan || typeof plan !== "object") {
    return null;
  }

  const { resourceBodies, ...persisted } = plan;
  return persisted;
}
