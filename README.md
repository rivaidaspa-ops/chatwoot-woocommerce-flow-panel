# Panel Chatwoot + WooCommerce + Flow Chile

Aplicación web Node.js + Express protegida por HTTP Basic Auth y login visual. Permite consultar clientes y pedidos de WooCommerce, listar productos, crear pedidos, generar pagos Flow en CLP y enviar productos a una conversación de Chatwoot.

## Endpoints protegidos

Todos los endpoints exigen `Authorization: Basic base64(usuario:password)`:

- `GET /cliente?email=cliente@correo.cl`: obtiene cliente y pedidos desde WooCommerce.
- `GET /productos`: obtiene productos publicados de WooCommerce.
- `POST /crear-pedido`: crea pedido con billing, shipping, productos, cantidades y método de pago.
- `POST /pagar`: crea pago Flow y retorna URL de pago.
- `POST /chatwoot/enviar-producto`: envía producto como mensaje a conversación Chatwoot.
- `GET /health`: prueba de autenticación y estado.

## Instalación local

```bash
npm install
cp .env.example .env
nano .env
npm start
```

Abra:

```text
http://localhost:3000
```

## Variables de entorno

Complete `.env` con:

```bash
PANEL_USER=admin
PANEL_PASSWORD=una_password_segura
WC_URL=https://tutienda.cl
WC_KEY=ck_xxx
WC_SECRET=cs_xxx
FLOW_API_URL=https://sandbox.flow.cl/api
FLOW_API_KEY=xxx
FLOW_SECRET_KEY=xxx
CHATWOOT_URL=https://chatwoot.tudominio.cl
CHATWOOT_API_KEY=xxx
CHATWOOT_ACCOUNT_ID=1
PUBLIC_BASE_URL=https://panel.tudominio.cl
```

Para producción, use `FLOW_API_URL=https://www.flow.cl/api`.

## Registro como panel de aplicación en Chatwoot

En Chatwoot, registre la URL del panel usando los parámetros dinámicos disponibles en su instalación. Ejemplo:

```text
https://panel.tudominio.cl/?email={{email_cliente}}&conversation_id={{conversation.id}}
```

Si su variable de email tiene otro nombre, use el parámetro que entrega su Chatwoot. El frontend también acepta `email`, `email_cliente`, `conversation_id` y `conversationId`.

## Crear pedido

Ejemplo de payload para `POST /crear-pedido`:

```json
{
  "payment_method": "flow",
  "payment_method_title": "Flow - Webpay / Multicaja",
  "billing": {
    "first_name": "Juan",
    "last_name": "Perez",
    "email": "juan@correo.cl",
    "phone": "+56912345678",
    "address_1": "Av. Providencia 123",
    "city": "Santiago",
    "state": "RM",
    "country": "CL"
  },
  "shipping": {
    "first_name": "Juan",
    "last_name": "Perez",
    "address_1": "Av. Providencia 123",
    "city": "Santiago",
    "state": "RM",
    "country": "CL"
  },
  "line_items": [
    { "product_id": 123, "quantity": 2 }
  ]
}
```

El backend valida que los productos existan, estén disponibles y tengan stock suficiente cuando WooCommerce gestiona stock.

## Pago Flow

`POST /pagar` crea un pago Flow con moneda CLP y retorna:

```json
{
  "ok": true,
  "url": "https://...flow...?token=...",
  "token": "..."
}
```

El botón del frontend abre esa URL en una pestaña nueva.

## Despliegue en CloudPanel o EasyPanel

1. Suba la carpeta del proyecto al servidor.
2. Configure Node.js 18 o superior.
3. Ejecute `npm install --omit=dev`.
4. Cree el archivo `.env` con valores reales.
5. Configure el proceso de inicio: `npm start`.
6. Publique el puerto definido en `PORT`, normalmente `3000`.
7. Configure proxy HTTPS hacia el dominio del panel.
8. Añada el dominio del panel y el dominio Chatwoot en `ALLOWED_ORIGINS`.

## Seguridad incluida

- Login visual antes de mostrar datos.
- HTTP Basic Auth obligatorio en frontend, API y archivos estáticos.
- Credenciales por variables de entorno.
- CORS restringible por `ALLOWED_ORIGINS`.
- Helmet para cabeceras de seguridad.
- Validación básica de payloads y stock.

## Notas importantes

- No exponga `.env` públicamente.
- Use HTTPS en producción.
- Use claves WooCommerce con permisos de lectura/escritura.
- En Flow, configure correctamente `urlConfirmation` y `urlReturn`.
- Para marcar pedidos como pagados automáticamente, complete la lógica de `/flow/confirmacion` consultando `payment/getStatus` y actualizando el pedido en WooCommerce.
