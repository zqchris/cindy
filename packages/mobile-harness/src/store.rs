use crate::{Result, types::Session};
use std::{
    fs::{self, File},
    io::Write,
    path::{Path, PathBuf},
};

pub struct Store {
    root: PathBuf,
}
impl Store {
    pub fn new(root: &Path) -> Result<Self> {
        if !root.is_absolute() {
            return Err("INVALID_ROOT".into());
        }
        fs::create_dir_all(root.join("sessions"))?;
        fs::create_dir_all(root.join("workspaces"))?;
        Ok(Self {
            root: root.to_owned(),
        })
    }
    pub fn validate_id(id: &str) -> Result<()> {
        uuid::Uuid::parse_str(id).map_err(|_| "INVALID_SESSION_ID")?;
        Ok(())
    }
    fn path(&self, id: &str) -> Result<PathBuf> {
        Self::validate_id(id)?;
        Ok(self.root.join("sessions").join(format!("{id}.json")))
    }
    pub fn find(&self, id: &str) -> Result<Option<Session>> {
        match fs::metadata(self.path(id)?) {
            Ok(_) => self.load(id).map(Some),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(error.into()),
        }
    }
    pub fn load(&self, id: &str) -> Result<Session> {
        let session: Session = serde_json::from_reader(File::open(self.path(id)?)?)?;
        if session.version != 1
            || session.id != id
            || session.context_start > session.messages.len()
        {
            return Err("INVALID_SESSION".into());
        }
        Ok(session)
    }
    pub fn save(&self, session: &Session) -> Result<()> {
        let dest = self.path(&session.id)?;
        let temp = dest.with_extension("pending");
        let mut file = File::create(&temp)?;
        serde_json::to_writer(&mut file, session)?;
        file.flush()?;
        file.sync_all()?;
        fs::rename(temp, dest)?;
        File::open(self.root.join("sessions"))?.sync_all()?;
        Ok(())
    }
    pub fn list(&self) -> Result<Vec<Session>> {
        let mut sessions = vec![];
        for entry in fs::read_dir(self.root.join("sessions"))? {
            let path = entry?.path();
            if path.extension().and_then(|x| x.to_str()) == Some("json") {
                let id = path
                    .file_stem()
                    .and_then(|x| x.to_str())
                    .ok_or("INVALID_SESSION")?;
                // Corruption is visible; never silently overwrite or discard a task.
                sessions.push(self.load(id)?);
            }
        }
        Ok(sessions)
    }
    pub fn workspace(&self, id: &str) -> Result<cap_std::fs::Dir> {
        Self::validate_id(id)?;
        let path = self.root.join("workspaces").join(id);
        fs::create_dir_all(&path)?;
        Ok(cap_std::fs::Dir::open_ambient_dir(
            path,
            cap_std::ambient_authority(),
        )?)
    }
}
