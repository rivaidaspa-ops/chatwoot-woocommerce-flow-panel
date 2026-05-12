# Subir v8.0

1. Descomprime este ZIP y reemplaza todos los archivos del proyecto.
2. En VS Code:

```bash
git add -A
git commit -m "Fix v8 credentials storage and Woo tests for Chile Colombia"
git push
```

3. En EasyPanel: Deploy.
4. En el panel: Credenciales -> completar Woo Chile/Woo Colombia -> Guardar credenciales -> Probar Woo Chile / Probar Woo Colombia.

Variables mínimas en EasyPanel:

```env
NODE_ENV=production
PORT=3001
PUBLIC_BASE_URL=https://app.rivaida.cl
ALLOWED_ORIGINS=
PANEL_USER=admin
PANEL_PASSWORD=admin123
PANEL_APP_TOKEN=panel_seguro_2026
DATABASE_URL=postgres://paneluser:Rivaida1012@chatriva-ai_panel-postgres:5432/paneldb?sslmode=disable
REDIS_URL=redis://default:Rivaida1012@chatriva-ai_panel-redis:6379
DEFAULT_STORE=cl
CACHE_ENABLED=true
CHATWOOT_SEND_IMAGE_ATTACHMENT=true
PAYMENT_LINK_PROVIDER=woocommerce
```
