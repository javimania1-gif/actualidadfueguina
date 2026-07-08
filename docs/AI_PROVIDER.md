# Proveedor de IA

Variables:
- `AF_AI_PROVIDER`: proveedor logico. Valor actual: `github`.
- `AF_AI_MODEL`: modelo del proveedor.
- `AF_MODEL`: compatibilidad anterior; se usa si `AF_AI_MODEL` no esta definido.

Implementacion actual:
- `scripts/lib/ai-provider.mjs`
- endpoint GitHub Models
- token: `GITHUB_TOKEN`

No hay proveedores ficticios. Para agregar otro proveedor, implementar una rama real en `callAiJson()` con autenticacion, endpoint, modelo y formato de respuesta comprobados.
