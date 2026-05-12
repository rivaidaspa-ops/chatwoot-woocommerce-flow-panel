# Rivaida Commerce Hub v8.4

Panel profesional para Chatwoot + WooCommerce con tiendas separadas Chile/Colombia.

## Cambios v8.4
- Aislamiento fuerte por país/tienda: productos, carrito, pedidos, pagos, envíos, caché e índice separados por `store`.
- Nombre profesional: **Rivaida Commerce Hub**.
- Se eliminó el bloque de venta rápida Dropi de la interfaz principal.
- Asistente de venta independiente para Chile y Colombia.
- Diagnóstico visual: modal Estado/Logs con Woo Chile, Woo Colombia, Chatwoot, Redis, índice rápido y logs.
- Corrección `getMetaValue` para evitar errores en metadatos de Chatwoot/Woo.
- Envío de productos a Chatwoot/WhatsApp con imagen como adjunto cuando el canal/API lo permite y fallback con URL.
- Productos con stock primero también en Colombia.

## URL Chatwoot Dashboard App
```
https://app.rivaida.cl/?panel_token=panel_seguro_2026
```

## Variables mínimas EasyPanel
```env
NODE_ENV=production
PORT=3001
PUBLIC_BASE_URL=https://app.rivaida.cl
ALLOWED_ORIGINS=
PANEL_USER=admin
PANEL_PASSWORD=admin123
PANEL_APP_TOKEN=panel_seguro_2026
DATABASE_URL=postgres://paneluser:TU_PASSWORD@chatriva-ai_panel-postgres:5432/paneldb?sslmode=disable
REDIS_URL=redis://default:TU_PASSWORD@chatriva-ai_panel-redis:6379
DEFAULT_STORE=cl
CACHE_ENABLED=true
CHATWOOT_SEND_IMAGE_ATTACHMENT=true
PAYMENT_LINK_PROVIDER=woocommerce
```

Las credenciales Woo/Chatwoot/IA se cargan desde el modal **Credenciales**.
