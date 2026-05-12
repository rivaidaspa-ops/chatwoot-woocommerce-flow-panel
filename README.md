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


## v6.4
- Validador de RUT local y en backend.
- Integración con conversación Chatwoot: envío de productos, aplicación de etiquetas y recomendaciones.
- Asistente de venta con reglas locales; opcionalmente puede usar `AI_RECOMMENDATION_WEBHOOK_URL` para conectar una IA externa.
- Más temas visuales: claro, oscuro, compacto, premium y alto contraste; más acentos: teal, azul, verde, grafito, naranjo, morado, cyan, rosa y negro.

### URL como aplicación/panel en Chatwoot
Usa una URL como:
`https://TU-DOMINIO/?email={{contact.email}}&conversation_id={{conversation.id}}&panel_token=TU_PANEL_APP_TOKEN`

Variables necesarias para Chatwoot:
`CHATWOOT_URL`, `CHATWOOT_API_KEY`, `CHATWOOT_ACCOUNT_ID`, `PANEL_APP_TOKEN`.


## v6.5 - Corrección RUT y regiones Chile

- El RUT se guarda en varias claves de metadatos para compatibilidad con campos personalizados WooCommerce/AliDropship: `_billing_rut`, `billing_rut`, `rut`, `_rut`, `billing_run`, `billing_dni`, `billing_document`, `billing_documento`, `billing_tax_id` y versiones limpias sin puntos/guion.
- La región se envía por defecto como nombre legible en `billing.state` y `shipping.state` para evitar que WooCommerce muestre `CL-RM` en la dirección. El código se conserva en `_billing_region_code`.
- Si por alguna configuración de WooCommerce necesita volver a enviar el código, agregue `CHILE_STATE_FORMAT=code` en variables de entorno.
- Las comunas siguen usando `billing.city`/`shipping.city` y el código postal se resuelve automáticamente desde la comuna, compatible con Chile Postcodes for WooCommerce.


## v6.6

- UI con Bootstrap 5.3 por CDN.
- Color de acento corregido: no cambia el color general de textos.
- RUT compatible con AliDropship: se guarda como `cpf`, `billing_cpf`, `rut_code`, `billing_rut`, `_billing_rut` y claves equivalentes.
- AliDropship Woo usa en su JS de orden API `address.cpf`; por eso el panel envía RUT limpio y formateado en esos metadatos.
- Para IA opcional agrega `AI_RECOMMENDATION_WEBHOOK_URL=https://tu-webhook`.


## v6.7
- AliDropship: RUT tambien se guarda como `billing_rut`, `shipping_rut`, `cpf` y `code_number`.
- Regiones: nombres sin tildes para compatibilidad; `CL-RM` se muestra como `Metropolitana de Santiago`.

## v6.8
- RUT reducido: solo se envía en `billing_rut`, `_billing_rut`, `shipping_rut` y `_shipping_rut` para evitar llenar WooCommerce con campos personalizados duplicados.
- Se eliminan alias `cpf`, `code_number` y equivalentes del envío nuevo.
- Métodos de pago de WooCommerce cargados automáticamente desde `/payment_gateways`.
- Link de pago Flow desde pedido creado o pedido existente.
- Ver detalle de pedido y editar estado/nota desde el panel.
- Interfaz Bootstrap más moderna para pedidos, checkout y catálogo.

### Nuevos endpoints
- `GET /payment-methods`
- `GET /pedidos/buscar?q=texto&email=cliente@correo.cl`
- `GET /pedidos/:id`
- `PATCH /pedidos/:id`
