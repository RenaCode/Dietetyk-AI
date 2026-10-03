{{/*
Expand the name of the chart.
*/}}
{{- define "dietetyk.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create a default fully qualified app name.
*/}}
{{- define "dietetyk.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{/*
Create chart name and version as used by the chart label.
*/}}
{{- define "dietetyk.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Common labels
*/}}
{{- define "dietetyk.labels" -}}
helm.sh/chart: {{ include "dietetyk.chart" . }}
{{ include "dietetyk.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/*
Selector labels
*/}}
{{- define "dietetyk.selectorLabels" -}}
app.kubernetes.io/name: {{ include "dietetyk.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
Image pull secrets.

The backend and frontend images live in GitHub Container Registry under
ghcr.io/renacode/*, and those packages are PRIVATE. A private GHCR package
issues no anonymous pull token, so without credentials the kubelet gets HTTP 401
and the pod sits in ImagePullBackOff. This is easy to misdiagnose as a missing
or mistyped image tag, because the error surfaces the same way.

Docker Compose on the VPS does not hit this, because a one-off `docker login
ghcr.io` there leaves credentials in ~/.docker/config.json. Kubernetes has no
equivalent ambient login - every node needs an explicit pull secret.

Renders nothing when the list is empty, so a deployment using public images (or
a cluster with registry credentials wired in at node level) stays unaffected.
*/}}
{{- define "dietetyk.imagePullSecrets" -}}
{{- with .Values.imagePullSecrets }}
imagePullSecrets:
{{- range . }}
  - name: {{ .name }}
{{- end }}
{{- end }}
{{- end }}

{{/*
EGRESS RULES - EVERYTHING EXCEPT THE HOME NETWORK (2026-10-03).

The node routes 192.168.3.0/24 and 10.13.13.0/24 through wg0 (the tunnel home), and the
UDM accepts all of 10.13.13.0/24 - without this policy every pod reached the UDM, the TV
and Fibaro. Three rules, OR-ed:

  1. DNS to CoreDNS (UDP and TCP 53),
  2. any pod in the cluster (`namespaceSelector: {}`) - in-cluster traffic unchanged;
     kube-router evaluates egress AFTER kube-proxy's DNAT, so a ClusterIP is already a
     pod address by then,
  3. every IPv4 address outside `networkPolicy.egress.siecDomowa` - the internet and the
     NODE address that the API server ClusterIP (10.43.0.1:443 -> :6443) is DNAT-ed to.

In kube-router an ipBlock matches ANY destination address, pod addresses included (hash:net
ipset, exceptions as `nomatch` entries, /0 split into two /1 - pkg/controllers/netpol/
policy.go, evalIPBlockPeer). Rule 2 stays anyway: the NetworkPolicy spec does not promise
that ipBlock covers pods, so in-cluster traffic should not depend on it.
*/}}
{{- define "dietetyk.regulyEgress" -}}
- to:
    - namespaceSelector:
        matchLabels:
          kubernetes.io/metadata.name: kube-system
      podSelector:
        matchLabels:
          k8s-app: kube-dns
  ports:
    - { protocol: UDP, port: 53 }
    - { protocol: TCP, port: 53 }
- to:
    - namespaceSelector: {}
- to:
    - ipBlock:
        cidr: 0.0.0.0/0
        except: {{- toYaml .Values.networkPolicy.egress.siecDomowa | nindent 10 }}
{{- end -}}
