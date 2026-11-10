// Definicje CRD instalowanych w klastrze (Gateway API, NGF, Calico) oraz cert-manager.

const str = (description, extra = {}) => ({ type: 'string', description, ...extra });
const int = (description, extra = {}) => ({ type: 'integer', description, ...extra });
const bool = (description) => ({ type: 'boolean', description });
const arr = (items, description) => ({ type: 'array', description, items });
const obj = (properties, description, required, extra = {}) => ({ type: 'object', description, properties, ...(required ? { required } : {}), ...extra });
const free = (description) => ({ type: 'object', description, 'x-kubernetes-preserve-unknown-fields': true });
const sel = (description) => obj({ matchLabels: { type: 'object', additionalProperties: { type: 'string' }, description: 'Map of key/value pairs that must match.' }, matchExpressions: arr(obj({ key: str('Label key.'), operator: str('In, NotIn, Exists or DoesNotExist.'), values: arr(str(''), 'Values.') }, '', ['key', 'operator']), 'Label selector requirements.') }, description);

function crd(group, kind, plural, { scope = 'Namespaced', short = [], categories = [], versions, columns = [], labels = {} }) {
  return {
    apiVersion: 'apiextensions.k8s.io/v1', kind: 'CustomResourceDefinition',
    metadata: { name: `${plural}.${group}`, labels, annotations: group.includes('gateway.networking') ? { 'gateway.networking.k8s.io/bundle-version': 'v1.6.3', 'gateway.networking.k8s.io/channel': 'standard' } : {} },
    spec: {
      group, scope,
      names: { kind, listKind: `${kind}List`, plural, singular: kind.toLowerCase(), ...(short.length ? { shortNames: short } : {}), ...(categories.length ? { categories } : {}) },
      versions: versions.map((v, i) => ({ name: v.name, served: true, storage: i === 0, schema: { openAPIV3Schema: v.schema }, subresources: { status: {} }, additionalPrinterColumns: columns })),
    },
  };
}

const top = (spec, desc) => obj({ apiVersion: str('APIVersion of the object.'), kind: str('Kind of the object.'), metadata: { type: 'object', description: 'Standard object metadata.' }, spec, status: free('Status of the resource.') }, desc);

const parentRef = obj({
  group: str('Group of the referent. Defaults to gateway.networking.k8s.io.', { default: 'gateway.networking.k8s.io' }),
  kind: str('Kind of the referent. Defaults to Gateway.', { default: 'Gateway' }),
  namespace: str('Namespace of the referent. Defaults to the namespace of the Route.'),
  name: str('Name of the referent (e.g. the Gateway).'),
  sectionName: str('Name of a section (listener) within the target resource.'),
  port: int('Network port this Route targets.'),
}, 'Reference to a resource (usually a Gateway) the Route attaches to.', ['name']);

const backendRef = obj({
  group: str('Group of the referent. Empty means core API group.', { default: '' }),
  kind: str('Kind of the referent. Defaults to Service.', { default: 'Service' }),
  name: str('Name of the referent.'),
  namespace: str('Namespace of the backend. Cross-namespace references need a ReferenceGrant.'),
  port: int('Destination port number on the referent. Required for Services.'),
  weight: int('Proportion of requests forwarded to this backend (relative to the sum of weights).', { default: 1, minimum: 0, maximum: 1000000 }),
  filters: arr(free('Filter applied to requests sent to this backend.'), 'Filters for this backend.'),
}, 'Reference to a backend (usually a Service) receiving traffic.', ['name']);

const httpMatch = obj({
  path: obj({ type: str('How to match the path: Exact, PathPrefix or RegularExpression.', { default: 'PathPrefix', enum: ['Exact', 'PathPrefix', 'RegularExpression'] }), value: str('Value of the HTTP path to match.', { default: '/' }) }, 'HTTP request path matcher. Defaults to prefix "/".', null, { default: { type: 'PathPrefix', value: '/' } }),
  headers: arr(obj({ type: str('Exact or RegularExpression.', { enum: ['Exact', 'RegularExpression'] }), name: str('HTTP header name.'), value: str('Header value to match.') }, '', ['name', 'value']), 'HTTP request header matchers (ANDed).'),
  queryParams: arr(obj({ type: str('Exact or RegularExpression.'), name: str('Query parameter name.'), value: str('Value to match.') }, '', ['name', 'value']), 'Query parameter matchers (ANDed).'),
  method: str('HTTP method to match.', { enum: ['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'CONNECT', 'OPTIONS', 'TRACE', 'PATCH'] }),
}, 'Predicate a request must satisfy to match a rule.');

const filter = obj({
  type: str('Type of filter: RequestHeaderModifier, ResponseHeaderModifier, RequestRedirect, URLRewrite, RequestMirror, ExtensionRef.', { enum: ['RequestHeaderModifier', 'ResponseHeaderModifier', 'RequestMirror', 'RequestRedirect', 'URLRewrite', 'ExtensionRef', 'CORS'] }),
  requestHeaderModifier: free('Modifies request headers.'),
  responseHeaderModifier: free('Modifies response headers.'),
  requestRedirect: obj({ scheme: str('Scheme in the Location header.'), hostname: str('Hostname in the Location header.'), path: free('Path modifier.'), port: int('Port in the Location header.'), statusCode: int('HTTP status code (301 or 302).', { default: 302 }) }, 'Returns a redirect response.'),
  urlRewrite: obj({ hostname: str('Value used to replace the Host header.'), path: obj({ type: str('ReplaceFullPath or ReplacePrefixMatch.'), replaceFullPath: str('Value replacing the full path.'), replacePrefixMatch: str('Value replacing the matched prefix.') }, 'Path rewrite.') }, 'Rewrites the request before it is forwarded.'),
  requestMirror: free('Mirrors requests to another backend.'),
  extensionRef: free('Implementation-specific filter.'),
  cors: free('CORS configuration.'),
}, 'Processing step applied to requests matching the rule.', ['type']);

function gatewayApi() {
  const gatewayClass = top(obj({
    controllerName: str('Name of the controller managing Gateways of this class (e.g. gateway.nginx.org/nginx-gateway-controller).'),
    parametersRef: obj({ group: str(''), kind: str(''), name: str(''), namespace: str('') }, 'Reference to implementation-specific parameters.', ['group', 'kind', 'name']),
    description: str('Human-readable description of the class.'),
  }, 'Spec of the GatewayClass.', ['controllerName']), 'GatewayClass describes a class of Gateways available in the cluster.');
  const listener = obj({
    name: str('Unique name of the listener within the Gateway.'),
    hostname: str('Hostname to match. If empty, all hostnames match. Wildcards like *.example.com are allowed.'),
    port: int('Network port the listener listens on.', { minimum: 1, maximum: 65535 }),
    protocol: str('Network protocol: HTTP, HTTPS, TLS, TCP or UDP.'),
    tls: free('TLS configuration for HTTPS/TLS listeners.'),
    allowedRoutes: obj({
      namespaces: obj({ from: str('Namespaces Routes may attach from: All, Same (default) or Selector.', { default: 'Same', enum: ['All', 'Selector', 'Same'] }), selector: sel('Namespace label selector, used with from: Selector.') }, 'Namespaces from which Routes may attach.', null, { default: { from: 'Same' } }),
      kinds: arr(obj({ group: str(''), kind: str('') }, '', ['kind']), 'Kinds of Routes allowed to attach.'),
    }, 'Types of Routes that may attach to this listener and from which namespaces.', null, { default: { namespaces: { from: 'Same' } } }),
  }, 'A logical endpoint where the Gateway accepts connections.', ['name', 'port', 'protocol']);
  const gateway = top(obj({
    gatewayClassName: str('Name of the GatewayClass used for this Gateway.'),
    listeners: arr(listener, 'Logical endpoints bound on the Gateway addresses. At least one is required.'),
    addresses: arr(obj({ type: str('IPAddress or Hostname.'), value: str('Address value.') }, '', ['value']), 'Requested addresses for the Gateway.'),
    infrastructure: free('Infrastructure labels and annotations.'),
  }, 'Desired state of the Gateway.', ['gatewayClassName', 'listeners']), 'Gateway represents an instance of a service-traffic handling infrastructure bound to a GatewayClass.');
  const httpRoute = top(obj({
    parentRefs: arr(parentRef, 'References to resources (Gateways) this Route wants to attach to.'),
    hostnames: arr(str(''), 'Hostnames matched against the HTTP Host header.'),
    rules: arr(obj({
      name: str('Optional name of the rule.'),
      matches: arr(httpMatch, 'Conditions used to match HTTP requests (ORed). Defaults to path prefix "/".'),
      filters: arr(filter, 'Filters applied to matching requests.'),
      backendRefs: arr(backendRef, 'Backends where matching requests are sent.'),
      timeouts: obj({ request: str('Request timeout.'), backendRequest: str('Backend request timeout.') }, 'Timeouts for the rule.'),
    }, 'HTTP rule: matches, filters and backends.'), 'List of HTTP matchers, filters and actions.', null),
  }, 'Desired state of the HTTPRoute.'), 'HTTPRoute provides a way to route HTTP requests.');
  const grpcRoute = top(obj({ parentRefs: arr(parentRef, 'Parent resources.'), hostnames: arr(str(''), 'Hostnames.'), rules: arr(free('GRPC rule.'), 'Rules.') }, 'Desired state of GRPCRoute.'), 'GRPCRoute provides a way to route gRPC requests.');
  const refGrant = top(obj({
    from: arr(obj({ group: str('Group of the referencing resource.'), kind: str('Kind of the referencing resource (e.g. HTTPRoute).'), namespace: str('Namespace of the referencing resource.') }, '', ['group', 'kind', 'namespace']), 'Trusted namespaces and kinds that may reference resources in this namespace.'),
    to: arr(obj({ group: str('Group of the referent ("" for core).'), kind: str('Kind of the referent (e.g. Service).'), name: str('Optional name of the referent.') }, '', ['group', 'kind']), 'Resources that may be referenced.'),
  }, 'Spec of ReferenceGrant.', ['from', 'to']), 'ReferenceGrant allows cross-namespace references to resources in the namespace it lives in.');
  const cols = {
    gc: [{ jsonPath: '.spec.controllerName', name: 'Controller', type: 'string' }, { jsonPath: ".status.conditions[?(@.type==\"Accepted\")].status", name: 'Accepted', type: 'string' }, { jsonPath: '.metadata.creationTimestamp', name: 'Age', type: 'date' }],
    gw: [{ jsonPath: '.spec.gatewayClassName', name: 'Class', type: 'string' }, { jsonPath: '.status.addresses[*].value', name: 'Address', type: 'string' }, { jsonPath: ".status.conditions[?(@.type==\"Programmed\")].status", name: 'Programmed', type: 'string' }, { jsonPath: '.metadata.creationTimestamp', name: 'Age', type: 'date' }],
    hr: [{ jsonPath: '.spec.hostnames', name: 'Hostnames', type: 'string' }, { jsonPath: '.metadata.creationTimestamp', name: 'Age', type: 'date' }],
  };
  return [
    crd('gateway.networking.k8s.io', 'GatewayClass', 'gatewayclasses', { scope: 'Cluster', short: ['gc'], categories: ['gateway-api'], columns: cols.gc, versions: [{ name: 'v1', schema: gatewayClass }] }),
    crd('gateway.networking.k8s.io', 'Gateway', 'gateways', { short: ['gtw'], categories: ['gateway-api'], columns: cols.gw, versions: [{ name: 'v1', schema: gateway }] }),
    crd('gateway.networking.k8s.io', 'HTTPRoute', 'httproutes', { categories: ['gateway-api'], columns: cols.hr, versions: [{ name: 'v1', schema: httpRoute }] }),
    crd('gateway.networking.k8s.io', 'GRPCRoute', 'grpcroutes', { categories: ['gateway-api'], columns: cols.hr, versions: [{ name: 'v1', schema: grpcRoute }] }),
    crd('gateway.networking.k8s.io', 'ReferenceGrant', 'referencegrants', { short: ['refgrant'], categories: ['gateway-api'], columns: [{ jsonPath: '.metadata.creationTimestamp', name: 'Age', type: 'date' }], versions: [{ name: 'v1beta1', schema: refGrant }] }),
    crd('gateway.networking.k8s.io', 'BackendTLSPolicy', 'backendtlspolicies', { short: ['btlspolicy'], categories: ['gateway-api'], versions: [{ name: 'v1', schema: top(free('Spec.'), 'BackendTLSPolicy configures TLS between a Gateway and a backend.') }] }),
  ];
}

function ngf() {
  const mk = (kind, plural, scope = 'Namespaced') => crd('gateway.nginx.org', kind, plural, { scope, categories: ['nginx-gateway-fabric'], labels: { 'app.kubernetes.io/name': 'nginx-gateway-fabric' }, versions: [{ name: kind === 'NginxProxy' || kind === 'NginxGateway' ? 'v1alpha2' : 'v1alpha1', schema: top(free('Spec.'), `${kind} is an NGINX Gateway Fabric resource.`) }] });
  return [mk('ClientSettingsPolicy', 'clientsettingspolicies'), mk('NginxGateway', 'nginxgateways'), mk('NginxProxy', 'nginxproxies'), mk('ObservabilityPolicy', 'observabilitypolicies'), mk('SnippetsFilter', 'snippetsfilters'), mk('UpstreamSettingsPolicy', 'upstreamsettingspolicies')];
}

function calico() {
  const g = 'crd.projectcalico.org';
  const list = [['BGPConfiguration', 'bgpconfigurations', 'Cluster'], ['BGPFilter', 'bgpfilters', 'Cluster'], ['BGPPeer', 'bgppeers', 'Cluster'], ['BlockAffinity', 'blockaffinities', 'Cluster'], ['CalicoNodeStatus', 'caliconodestatuses', 'Cluster'], ['ClusterInformation', 'clusterinformations', 'Cluster'], ['FelixConfiguration', 'felixconfigurations', 'Cluster'], ['GlobalNetworkPolicy', 'globalnetworkpolicies', 'Cluster'], ['GlobalNetworkSet', 'globalnetworksets', 'Cluster'], ['HostEndpoint', 'hostendpoints', 'Cluster'], ['IPAMBlock', 'ipamblocks', 'Cluster'], ['IPAMConfig', 'ipamconfigs', 'Cluster'], ['IPAMHandle', 'ipamhandles', 'Cluster'], ['IPPool', 'ippools', 'Cluster'], ['IPReservation', 'ipreservations', 'Cluster'], ['KubeControllersConfiguration', 'kubecontrollersconfigurations', 'Cluster'], ['NetworkPolicy', 'networkpolicies', 'Namespaced'], ['NetworkSet', 'networksets', 'Namespaced'], ['Tier', 'tiers', 'Cluster']];
  return list.map(([k, p, scope]) => crd(g, k, p, { scope, versions: [{ name: 'v1', schema: top(free('Spec.'), `${k} is a Calico resource.`) }] }));
}

export function gatewayCrds() {
  return [...gatewayApi(), ...ngf(), ...calico()];
}

// ------------------------------------------------------------------ cert-manager (instalowany przez kubectl apply -f <URL>)
export function certManagerCrds(version) {
  const g = 'cert-manager.io';
  const issuerRef = obj({ name: str('Name of the issuer.'), kind: str('Kind of the issuer: Issuer or ClusterIssuer.'), group: str('Group of the issuer.') }, 'Reference to the issuer for this certificate.', ['name']);
  const issuerSpec = obj({
    selfSigned: obj({ crlDistributionPoints: arr(str(''), '') }, 'Issues self-signed certificates.'),
    ca: obj({ secretName: str('Secret containing the signing CA keypair.') }, 'Issues certificates signed by a CA stored in a Secret.', ['secretName']),
    acme: free('ACME (e.g. Let\'s Encrypt) configuration.'),
    vault: free('HashiCorp Vault configuration.'),
    venafi: free('Venafi configuration.'),
  }, 'Desired state of the Issuer.');
  const cert = top(obj({
    secretName: str('Name of the Secret where the issued certificate and key are stored.'),
    commonName: str('Requested common name (CN).'),
    dnsNames: arr(str(''), 'Requested DNS subject alternative names.'),
    ipAddresses: arr(str(''), 'Requested IP address SANs.'),
    duration: str('Requested lifetime of the certificate, e.g. 2160h. Default 90 days.'),
    renewBefore: str('How long before expiry the certificate is renewed.'),
    issuerRef,
    isCA: bool('Mark the certificate as a CA.'),
    usages: arr(str(''), 'Requested key usages.'),
    privateKey: obj({ algorithm: str('RSA, ECDSA or Ed25519.'), size: int('Key size.'), rotationPolicy: str('Never or Always.') }, 'Private key options.'),
    subject: free('Full X.509 subject.'),
    secretTemplate: free('Labels and annotations for the Secret.'),
  }, 'Desired state of the Certificate.', ['secretName', 'issuerRef']), 'Certificate is a request for a signed certificate stored in a Secret.');
  const mk = (kind, plural, scope, schema, short, cols) => ({ ...crd(g, kind, plural, { scope, short, categories: ['cert-manager'], columns: cols, versions: [{ name: 'v1', schema }] }), metadata: { name: `${plural}.${g}`, labels: { 'app.kubernetes.io/instance': 'cert-manager', 'app.kubernetes.io/name': 'cert-manager', 'app.kubernetes.io/version': `v${version}` } } });
  const ready = [{ jsonPath: ".status.conditions[?(@.type==\"Ready\")].status", name: 'Ready', type: 'string' }];
  return [
    mk('Certificate', 'certificates', 'Namespaced', cert, ['cert', 'certs'], [...ready, { jsonPath: '.spec.secretName', name: 'Secret', type: 'string' }, { jsonPath: '.metadata.creationTimestamp', name: 'Age', type: 'date' }]),
    mk('CertificateRequest', 'certificaterequests', 'Namespaced', top(free('Spec.'), 'CertificateRequest is a request to an issuer for a certificate.'), ['cr', 'crs'], ready),
    mk('Issuer', 'issuers', 'Namespaced', top(issuerSpec, 'Issuer represents a certificate authority in a namespace.'), [], [...ready, { jsonPath: '.metadata.creationTimestamp', name: 'Age', type: 'date' }]),
    mk('ClusterIssuer', 'clusterissuers', 'Cluster', top(issuerSpec, 'ClusterIssuer represents a certificate authority usable from any namespace.'), [], [...ready, { jsonPath: '.metadata.creationTimestamp', name: 'Age', type: 'date' }]),
    { ...crd('acme.cert-manager.io', 'Order', 'orders', { versions: [{ name: 'v1', schema: top(free('Spec.'), 'Order is an ACME order.') }] }) },
    { ...crd('acme.cert-manager.io', 'Challenge', 'challenges', { versions: [{ name: 'v1', schema: top(free('Spec.'), 'Challenge is an ACME challenge.') }] }) },
  ];
}
