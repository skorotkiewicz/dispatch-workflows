#![cfg_attr(target_os = "windows", windows_subsystem = "windows")]
mod assets;
mod input;
mod ui;

use dispatch_rs::service::Handle;
use gpui::{prelude::*, *};

fn main() -> anyhow::Result<()> {
    let handle = Handle::launch()?;
    gpui_platform::application()
        .with_assets(assets::Assets)
        .run(move |cx| {
            input::bind_keys(cx);
            let bounds = Bounds::centered(None, size(px(1400.), px(900.)), cx);
            cx.open_window(
                WindowOptions {
                    window_bounds: Some(WindowBounds::Windowed(bounds)),
                    window_min_size: Some(size(px(1024.), px(650.))),
                    titlebar: Some(TitlebarOptions {
                        title: Some("Dispatch".into()),
                        ..Default::default()
                    }),
                    ..Default::default()
                },
                move |window, cx| cx.new(|cx| ui::Dispatch::new(handle, window, cx)),
            )
            .expect("Could not open the Dispatch window");
            cx.on_window_closed(|cx, _| {
                if cx.windows().is_empty() {
                    cx.quit();
                }
            })
            .detach();
            cx.activate(true);
        });
    Ok(())
}
