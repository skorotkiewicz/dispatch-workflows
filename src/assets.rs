use gpui::{App, AssetSource, SharedString};
use std::borrow::Cow;

pub const UI_FONT: &str = "Liberation Sans";
pub const MONO_FONT: &str = "Liberation Mono";

pub struct Assets;
impl AssetSource for Assets {
    fn load(&self, path: &str) -> anyhow::Result<Option<Cow<'static, [u8]>>> {
        let bytes: &'static [u8] = match path {
            "icons/workflow.svg" => include_bytes!("../assets/icons/workflow.svg"),
            "icons/clock.svg" => include_bytes!("../assets/icons/clock.svg"),
            "icons/github.svg" => include_bytes!("../assets/icons/github.svg"),
            "icons/settings.svg" => include_bytes!("../assets/icons/settings.svg"),
            "icons/refresh.svg" => include_bytes!("../assets/icons/refresh.svg"),
            "icons/search.svg" => include_bytes!("../assets/icons/search.svg"),
            "icons/branch.svg" => include_bytes!("../assets/icons/branch.svg"),
            "icons/info.svg" => include_bytes!("../assets/icons/info.svg"),
            "icons/play.svg" => include_bytes!("../assets/icons/play.svg"),
            "icons/shield.svg" => include_bytes!("../assets/icons/shield.svg"),
            "icons/queue.svg" => include_bytes!("../assets/icons/queue.svg"),
            "icons/check.svg" => include_bytes!("../assets/icons/check.svg"),
            "icons/cross.svg" => include_bytes!("../assets/icons/cross.svg"),
            "icons/chevron.svg" => include_bytes!("../assets/icons/chevron.svg"),
            "icons/up.svg" => include_bytes!("../assets/icons/up.svg"),
            "icons/down.svg" => include_bytes!("../assets/icons/down.svg"),
            "icons/return.svg" => include_bytes!("../assets/icons/return.svg"),
            "icons/logo.svg" => include_bytes!("../assets/icons/logo.svg"),
            _ => return Ok(None),
        };
        Ok(Some(Cow::Borrowed(bytes)))
    }
    fn list(&self, _path: &str) -> anyhow::Result<Vec<SharedString>> {
        Ok(vec![])
    }
}

pub fn load_fonts(cx: &App) {
    cx.text_system()
        .add_fonts(vec![
            Cow::Borrowed(include_bytes!("../assets/fonts/LiberationSans-Regular.ttf").as_slice()),
            Cow::Borrowed(include_bytes!("../assets/fonts/LiberationSans-Bold.ttf").as_slice()),
            Cow::Borrowed(include_bytes!("../assets/fonts/LiberationMono-Regular.ttf").as_slice()),
        ])
        .expect("Could not load bundled UI fonts");
}
