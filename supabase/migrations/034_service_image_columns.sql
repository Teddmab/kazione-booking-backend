-- 034_service_image_columns.sql — add support for multiple service images

ALTER TABLE services
  ADD COLUMN image_url_2 text,
  ADD COLUMN image_url_3 text;
