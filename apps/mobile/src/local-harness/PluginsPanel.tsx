import { useEffect, useState } from 'react';
import { Alert, Pressable, ScrollView, Switch, View } from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import { Text } from '@/components/AppText';
import { useLocale } from '@/i18n/useLocale';
import { useThemedStyles } from '@/theme';
import { installedPlugins, inspectPlugin, savePlugin, subscribePlugins } from './plugins';
import { localScope } from './storage';
import { harnessStyles } from './styles';
import { harnessMessages } from './messages';

export function PluginsPanel() {
  const styles = useThemedStyles(harnessStyles); const { effectiveLocale } = useLocale();
  const m = harnessMessages(effectiveLocale);
  const [plugins, setPlugins] = useState(installedPlugins); const [busy, setBusy] = useState(false);
  useEffect(() => subscribePlugins(() => setPlugins(installedPlugins())), []);
  const report = () => Alert.alert(m.error);
  const install = async () => {
    if (busy) return; const scope = localScope(); setBusy(true);
    try {
      const picked = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true }); scope.assert();
      if (picked.canceled) return;
      const plugin = await inspectPlugin(picked.assets[0].uri); scope.assert();
      Alert.alert(m.installTitle, `${plugin.manifest.name}\n${plugin.manifest.description ?? ''}\n\n${m.installHint}`, [
        { text: m.close, style: 'cancel' },
        { text: m.install, onPress: () => { try { scope.assert(); savePlugin(plugin); } catch { report(); } } },
      ]);
    } catch { report(); } finally { setBusy(false); }
  };
  return <ScrollView contentContainerStyle={styles.body}>
    <Text style={styles.small}>{m.pluginHint}</Text>
    <Pressable accessibilityRole="button" testID="local.plugin.install" disabled={busy} onPress={() => void install()} style={styles.button}>
      <Text style={styles.text}>{m.install}</Text>
    </Pressable>
    {!plugins.length ? <Text style={styles.small}>{m.noPlugins}</Text> : null}
    {plugins.map(p => <View key={p.manifest.id} style={styles.card}>
      <View style={styles.row}><View style={{ flex: 1 }}><Text style={styles.text}>{p.manifest.name}</Text>
        <Text style={styles.small}>{p.manifest.description}</Text></View>
        <Switch accessibilityLabel={p.manifest.name} value={p.enabled} onValueChange={enabled => {
          try { savePlugin({ ...p, enabled }); } catch { report(); }
        }} /></View>
    </View>)}
  </ScrollView>;
}
