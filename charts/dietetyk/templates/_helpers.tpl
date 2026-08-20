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
