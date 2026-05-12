# Chatwoot WooCommerce Flow Panel v6.9

Actualización enfocada en edición de pedidos sin bloqueo de pantalla.

## Cambios v6.9

- Edición de pedido en panel lateral independiente.
- Botones Volver / Cerrar visibles.
- Guardar estado y nota sin bloquear la interfaz.
- Cancelar pedido.
- Eliminar pedido enviándolo a papelera de WooCommerce.
- Generar link Flow desde pedido existente.
- Buscar pedido por número, email, nombre o SKU.
- Interfaz más moderna para detalle de pedido.

## Deploy

```bash
git add -A
git commit -m "Upgrade v6.9 order drawer delete cancel and Flow actions"
git push
```

En EasyPanel usar Dockerfile, ruta `/`, proxy al puerto 3001.


## v7 - Link de pago WooCommerce con Flow

La opción recomendada es crear el pedido en WooCommerce con el método de pago activo de Flow y generar el link de pago de WooCommerce. El cliente paga en el checkout/order-pay de WooCommerce y el plugin de Flow instalado en Woo se encarga de Webpay/Flow.

Endpoints nuevos:

- `POST /pedidos/:id/link-pago-woo`: actualiza el pedido con el gateway seleccionado y devuelve el link de pago WooCommerce.
- `GET /pedidos/:id/link-pago-woo`: devuelve el link de pago del pedido sin modificarlo.
- `POST /pagar` ahora usa WooCommerce si `PAYMENT_LINK_PROVIDER=woocommerce`; Flow directo queda como alternativa.

Variables nuevas recomendadas:

- `PUBLIC_BASE_URL`: dominio publico del panel.
- `WOO_FLOW_GATEWAY_ID`: ID del gateway Flow en WooCommerce, por ejemplo `flow`.
- `WOO_FLOW_GATEWAY_TITLE`: titulo visible del metodo.
- `PAYMENT_LINK_PROVIDER=woocommerce`: usa links de pago WooCommerce en vez de Flow directo.
- `PANEL_APP_TOKEN`: token para abrir el panel desde Chatwoot sin popup Basic Auth.


## v7.1
- El carrito ahora muestra miniatura del producto o variación seleccionada.
- Mejora visual del resumen del pedido antes de crear pedido o link de pago Woo.


## v7.3 Chatwoot automático

- La app escucha el contexto de Dashboard Apps mediante `postMessage` y solicita datos con `chatwoot-dashboard-app:fetch-info`.
- Si Chatwoot no trae email del contacto, consulta la conversación por API y busca un email escrito en los mensajes.
- Al enviar un producto, se envía el texto del producto con URL de imagen, SKU, variación, precio y link.
- Aplica etiquetas sin borrar las existentes y puede crear etiquetas/atributos recomendados.
- Guarda atributos comerciales en la conversación: `rivaida_estado`, `rivaida_ultimo_producto`, `rivaida_ultimo_sku`, `rivaida_email_detectado`.
