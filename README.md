# Chatwoot WooCommerce Flow Panel Chile v6

Version optimizada para EasyPanel con opcion Dockerfile, Redis y PostgreSQL.

## Mejoras v6

- Health check publico en `/health` para que EasyPanel no marque caida la app.
- `/productos` y `/productos/search` ahora cargan por paginas, no todo el catalogo.
- Boton `Ver mas productos` real.
- Variaciones bajo demanda: se cargan solo al tocar `Ver variaciones`.
- Imagen de variacion dinamica.
- Redis para cache rapido.
- PostgreSQL para indice local de productos.
- Sincronizacion en segundo plano con `/productos/sync`.
- Compatible con Chatwoot Custom App usando `panel_token` en la URL.

## Deploy en EasyPanel usando Dockerfile

1. En la app, Fuente: GitHub.
2. Compilacion: seleccionar `Dockerfile`.
3. Ruta Dockerfile: `/Dockerfile`.
4. Ruta de compilacion: `/`.
5. Puerto interno/proxy: `3001`.
6. Variables de entorno: copiar `.env.example` y reemplazar claves reales.
7. Guardar y Deploy.

## Variables importantes

```env
PORT=3001
PANEL_USER=admin
PANEL_PASSWORD=admin123
PANEL_APP_TOKEN=un_token_largo_para_chatwoot
DATABASE_URL=postgres://paneluser:Rivaida1012@chatriva-ai_panel-postgres:5432/paneldb?sslmode=disable
REDIS_URL=redis://default:Rivaida1012@chatriva-ai_panel-redis:6379
WC_URL=https://tutienda.cl
WC_KEY=ck_xxx
WC_SECRET=cs_xxx
FLOW_API_URL=https://www.flow.cl/api
FLOW_API_KEY=xxx
FLOW_SECRET_KEY=xxx
CHATWOOT_URL=https://chat.tudominio.cl
CHATWOOT_API_KEY=xxx
CHATWOOT_ACCOUNT_ID=1
```

## Integracion como App en Chatwoot

URL sugerida para el panel:

```text
https://panel.tudominio.cl/?email={{contact.email}}&conversation_id={{conversation.id}}&panel_token=TU_PANEL_APP_TOKEN
```

Si los placeholders de tu Chatwoot cambian, usa los equivalentes de email/contacto y conversation id.

## Primer uso

1. Abrir el panel.
2. Iniciar sesion con `PANEL_USER` y `PANEL_PASSWORD` o usar `panel_token` desde Chatwoot.
3. Presionar `Sincronizar catalogo`.
4. Esperar a que el contador termine.
5. Buscar productos por nombre, SKU, categoria u oferta.
6. Tocar `Ver variaciones` solo en los productos que necesitas revisar.

## Endpoints principales

- `GET /health` publico.
- `GET /cliente?email=cliente@correo.cl` protegido.
- `GET /productos/search?q=&category=&sale=false&stock=&limit=20&offset=0` protegido.
- `GET /productos/:id/variaciones` protegido.
- `POST /productos/sync` protegido, inicia sincronizacion en segundo plano.
- `GET /productos/sync/status` protegido.
- `POST /crear-pedido` protegido.
- `POST /pagar` protegido.
- `POST /chatwoot/enviar-producto` protegido.
- `POST /chatwoot/etiquetas` protegido.


## v6.3 UI limpia

- Se eliminaron los chips morados de atributos del listado de productos.
- Las variaciones se seleccionan con controles limpios por Color/Talla u otros atributos visibles.
- La imagen, SKU, precio y stock cambian según la variación seleccionada.
- Se agregó selector de tema: claro, oscuro y compacto, más color de acento.
